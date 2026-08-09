import { Request, Response } from "express";
import adminDb from "../config/firebase";
import logger from "../config/logger";
import { getFlutterwaveClient } from "../providers/flutterwave";
import { FieldValue } from "firebase-admin/firestore";
import { KycService } from "../services/kycService";
import { AuthenticatedRequest } from "../middleware/auth";

interface FlwTxRecord {
  id: string;
  userId?: string;
  amount?: number;
  currency?: string;
}

interface LedgerTxRecord {
  id: string;
  userId?: string;
  amount?: number;
  currency?: string;
  type?: string;
  flwId?: string;
  status?: string;
  fee?: number;
  createdAt?: string;
}

interface UserRecord {
  id: string;
  balance?: number;
  role?: string;
}

/**
 * Admin Controller for payment gateway.
 * Implements centralized, privileged Firestore Admin and business operations.
 */
export class AdminController {
  /**
   * Aggregates live system transaction metrics, volumes, and audit tallies.
   */
  public static async getMetrics(req: Request, res: Response): Promise<void> {
    const reqId = req.requestId;
    try {
      const db = adminDb;
      if (!db) {
        res.status(500).json({ success: false, message: "Firestore database not configured." });
        return;
      }

      logger.info(`[AdminController] Fetching metrics... | reqId=${reqId}`);

      const ledgerTxSnap = await db.collection("transactions").get();
      const ledgerDocs = ledgerTxSnap.docs.map((d) => d.data()) as LedgerTxRecord[];

      let totalDepositsVolume = 0;
      let successfulDepositsCount = 0;
      let failedDepositsCount = 0;

      let todaysDeposits = 0;
      let todaysWithdrawals = 0;
      let todaysTransfers = 0;
      let todaysInvestments = 0;
      let todaysAirtime = 0;
      let todaysBills = 0;

      let webhookCount = 0;
      let verificationFailures = 0;
      let duplicateAttempts = 0;

      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);

      ledgerDocs.forEach((tx) => {
        const txDate = tx.createdAt ? new Date(tx.createdAt) : null;
        const isToday = txDate && txDate >= startOfToday;
        const amt = Number(tx.amount) || 0;

        if (tx.type === "DEPOSIT") {
          if (tx.status === "SUCCESS") {
            totalDepositsVolume += amt;
            if (isToday) {
              todaysDeposits += amt;
              successfulDepositsCount++;
            }
          } else if (tx.status === "FAILED" && isToday) {
            failedDepositsCount++;
            verificationFailures++;
          }
        } else if (tx.type === "WITHDRAWAL") {
          if (tx.status === "SUCCESS" && isToday) {
            todaysWithdrawals += amt;
          }
        } else if (tx.type === "TRANSFER") {
          if (tx.status === "SUCCESS" && isToday) {
            todaysTransfers += amt;
          }
        } else if (tx.type === "INVESTMENT") {
          if (tx.status === "SUCCESS" && isToday) {
            todaysInvestments += amt;
          }
        } else if (tx.type === "AIRTIME") {
          if (tx.status === "SUCCESS" && isToday) {
            todaysAirtime += amt;
          }
        } else if (tx.type === "DATA" || tx.type === "BILLS") {
          if (tx.status === "SUCCESS" && isToday) {
            todaysBills += amt;
          }
        }

        // Check for duplicate attempts or webhook events
        const desc = (tx as any).description || "";
        if (desc.includes("already processed") || desc.includes("Duplicate")) {
          duplicateAttempts++;
        }
        if (desc.includes("Webhook") || desc.includes("webhook")) {
          webhookCount++;
        }
      });

      const pendingSnap = await db.collection("pending_payments").get();
      const activePendingPaymentsCount = pendingSnap.size;

      res.status(200).json({
        success: true,
        timestamp: new Date().toISOString(),
        metrics: {
          todaysSuccessfulPayments: successfulDepositsCount,
          todaysFailedPayments: failedDepositsCount,
          todaysDepositsVolume: totalDepositsVolume,
          activePendingPaymentsCount,
          todaysDeposits,
          todaysWithdrawals,
          todaysTransfers,
          todaysInvestments,
          todaysAirtime,
          todaysBills,
          webhookCount: webhookCount,
          verificationFailures: verificationFailures,
          duplicateBlockedCount: duplicateAttempts,
          averageVerificationTimeMs: null,
        },
      });
    } catch (error: any) {
      logger.error(`[AdminController] getMetrics exception: ${error.message} | reqId=${reqId}`);
      res.status(500).json({ success: false, message: "Failed to compile metrics dashboard.", error: error.message });
    }
  }

  /**
   * Scans system general ledger consistency, checks for discrepancies,
   * and auto-reconciles pending transfers older than 10 minutes.
   */
  public static async runReconciliation(req: Request, res: Response): Promise<void> {
    const reqId = req.requestId;
    try {
      const db = adminDb;
      if (!db) {
        res.status(500).json({ success: false, message: "Firestore database not configured." });
        return;
      }

      logger.info(`[AdminController] Initiating system-wide ledger reconciliation... | reqId=${reqId}`);

      const flwTxSnap = await db.collection("flutterwave_transactions").get();
      const ledgerTxSnap = await db.collection("transactions").get();
      const usersSnap = await db.collection("users").get();

      const flwDocs = flwTxSnap.docs.map((d) => ({ id: d.id, ...d.data() })) as FlwTxRecord[];
      const ledgerDocs = ledgerTxSnap.docs.map((d) => ({ id: d.id, ...d.data() })) as LedgerTxRecord[];
      const users = usersSnap.docs.map((d) => ({ id: d.id, ...d.data() })) as UserRecord[];

      const inconsistencies: Array<{
        type: "MISSING_LEDGER" | "MISSING_FLW_LOG" | "AMOUNT_MISMATCH" | "USER_BALANCE_ANOMALY";
        id: string;
        details: string;
      }> = [];

      const flwTxMap = new Map<string, FlwTxRecord>();
      flwDocs.forEach((doc) => flwTxMap.set(doc.id, doc));

      const ledgerTxMap = new Map<string, LedgerTxRecord>();
      ledgerDocs.forEach((doc) => {
        if (doc.flwId) ledgerTxMap.set(doc.flwId, doc);
      });

      // A. Verify Flutterwave logs have ledgers
      flwDocs.forEach((flwTx) => {
        const ledgerTx = ledgerTxMap.get(flwTx.id);
        if (!ledgerTx) {
          inconsistencies.push({
            type: "MISSING_LEDGER",
            id: flwTx.id,
            details: `Flutterwave transaction ${flwTx.id} processed but is missing a ledger transactions entry.`,
          });
        } else if (Math.abs(Number(flwTx.amount) - Number(ledgerTx.amount)) > 0.01) {
          inconsistencies.push({
            type: "AMOUNT_MISMATCH",
            id: flwTx.id,
            details: `Amount discrepancy. Idempotency logged: ${flwTx.amount}, ledger: ${ledgerTx.amount}`,
          });
        }
      });

      // B. Verify general ledger matches
      ledgerDocs.forEach((ledgerTx) => {
        if (ledgerTx.type === "DEPOSIT" && ledgerTx.flwId) {
          const flwTx = flwTxMap.get(ledgerTx.flwId);
          if (!flwTx) {
            inconsistencies.push({
              type: "MISSING_FLW_LOG",
              id: ledgerTx.id,
              details: `DEPOSIT ${ledgerTx.id} points to FLW ID ${ledgerTx.flwId} but no corresponding idempotency record exists.`,
            });
          }
        }
      });

      // C. Cross-check user balances
      users.forEach((user) => {
        const currentBalance = Number(user.balance) || 0;
        const userLedgerEntries = ledgerDocs.filter((tx) => tx.userId === user.id && tx.status === "SUCCESS");
        let calculatedBalance = 0;

        userLedgerEntries.forEach((tx) => {
          if (tx.type === "DEPOSIT") {
            calculatedBalance += Number(tx.amount) || 0;
          } else if (tx.type === "TRANSFER") {
            calculatedBalance -= (Number(tx.amount) || 0) + (Number(tx.fee) || 0);
          }
        });

        if (Math.abs(calculatedBalance - currentBalance) > 10.0) {
          inconsistencies.push({
            type: "USER_BALANCE_ANOMALY",
            id: user.id,
            details: `Balance mismatch variance. Database states: ₦${currentBalance}, computed ledger tally: ₦${calculatedBalance}`,
          });
        }
      });

      // D. Pending transfers reconciliation job
      const pendingTransfersSnap = await db.collection("transfers").where("status", "==", "PENDING").get();
      let reconciledCount = 0;
      let refundCount = 0;

      for (const doc of pendingTransfersSnap.docs) {
        const transferData = doc.data();
        const reference = doc.id;
        const createdAt = transferData.createdAt;

        if (!createdAt) continue;

        const ageMinutes = (Date.now() - new Date(createdAt).getTime()) / (60 * 1000);

        // Check if older than 10 minutes
        if (ageMinutes >= 10) {
          logger.info(`[AdminController] Auto-reconciling pending transfer ${reference} older than 10 mins.`);
          try {
            // Check status with Flutterwave
            const client = getFlutterwaveClient();
            const response = await client.request("get", `/transfers?reference=${reference}`);

            if (response && response.status === "success" && Array.isArray(response.data) && response.data.length > 0) {
              const flwTx = response.data[0];
              const latestStatus = flwTx.status?.toUpperCase() || "PENDING"; // "SUCCESS", "FAILED"

              if (latestStatus === "SUCCESS") {
                await db.collection("transfers").doc(reference).update({
                  status: "SUCCESS",
                  updatedAt: new Date().toISOString(),
                });
                reconciledCount++;
              } else if (latestStatus === "FAILED" || latestStatus === "REVERSED") {
                // Perform atomic rollback refund transaction
                const userRef = db.collection("users").doc(transferData.userId);
                const transferRef = db.collection("transfers").doc(reference);

                await db.runTransaction(async (transaction) => {
                  const trDoc = await transaction.get(transferRef);
                  const trData = trDoc.data() || {};

                  if (trData.status !== "PENDING" || trData.refunded) return;

                  const totalRefund = (Number(trData.amount) || 0) + (Number(trData.fee) || 0);
                  const uDoc = await transaction.get(userRef);

                  if (uDoc.exists) {
                    transaction.update(userRef, {
                      balance: FieldValue.increment(totalRefund),
                    });

                    const ledgerRef = db.collection("transactions").doc(`tx-REFUND-${reference}`);
                    transaction.set(ledgerRef, {
                      userId: trData.userId,
                      amount: totalRefund,
                      currency: "NGN",
                      reference: `REFUND-${reference}`,
                      type: "DEPOSIT",
                      description: `Reconciliation Refund for failed transfer to ${trData.recipientName || "Self"}`,
                      status: "SUCCESS",
                      date: new Date().toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" }),
                      time: new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
                      fee: 0,
                      createdAt: new Date().toISOString(),
                    });

                    transaction.update(transferRef, {
                      status: "FAILED",
                      refunded: true,
                      refundedAt: new Date().toISOString(),
                      updatedAt: new Date().toISOString(),
                    });

                    refundCount++;
                  }
                });
                reconciledCount++;
              }
            }
          } catch (fetchErr: any) {
            logger.error(`[AdminController] Failed to reconcile transfer reference ${reference}: ${fetchErr.message}`);
          }
        }
      }

      res.status(200).json({
        success: true,
        status: inconsistencies.length === 0 ? "BALANCED" : "DISCREPANCY_FOUND",
        timestamp: new Date().toISOString(),
        summary: {
          totalFlutterwaveLogs: flwDocs.length,
          totalGeneralLedgerLogs: ledgerDocs.length,
          totalUsersChecked: users.length,
          inconsistenciesFound: inconsistencies.length,
          pendingTransfersReconciled: reconciledCount,
          refundsExecuted: refundCount,
        },
        inconsistencies,
      });
    } catch (error: any) {
      logger.error(`[AdminController] runReconciliation exception: ${error.message} | reqId=${reqId}`);
      res.status(500).json({ success: false, message: "Ledger reconciliation scan failed.", error: error.message });
    }
  }

  /**
   * Securely retrieve PENDING KYC submissions. Visible only to human admins.
   * We do not expose raw documents to regular users.
   */
  public static async getPendingKycSubmissions(req: AuthenticatedRequest, res: Response): Promise<void> {
    const reqId = req.requestId;
    try {
      if (!adminDb) {
        res.status(500).json({ success: false, message: "Firestore database not configured." });
        return;
      }

      logger.info(`[AdminController] Admin ${req.user?.uid} fetching pending KYC submissions...`);

      const pendingSnap = await adminDb.collection("kyc_submissions")
        .where("status", "==", "PENDING")
        .limit(100)
        .get();

      const pendingUsers = pendingSnap.docs.map(doc => {
        const data = doc.data();
        return {
          uid: doc.id,
          name: `${data.firstName || ""} ${data.lastName || ""}`.trim() || "SUBMITTED USER",
          email: data.email || "",
          phoneNumber: data.phone || "",
          kycType: data.documentType || "bvn",
          kycNumber: data.documentNumber || "•••••••••••",
          kycStatus: data.status || "PENDING",
          submittedAt: data.submittedAt || new Date().toISOString(),
          capturedSelfie: data.capturedSelfie || null, // Securing within administrative session only
          livenessChallenge: data.livenessChallenge || null
        };
      });

      res.status(200).json({ success: true, pendingUsers });
    } catch (error: any) {
      logger.error(`[AdminController] getPendingKycSubmissions error: ${error.message} | reqId=${reqId}`);
      res.status(500).json({ success: false, message: "Failed to fetch pending KYC submissions.", error: error.message });
    }
  }

  /**
   * Approve a user's KYC submission securely.
   */
  public static async approveKycSubmission(req: AuthenticatedRequest, res: Response): Promise<void> {
    const reqId = req.requestId;
    const { userId } = req.params;
    const { provider } = req.body;
    const adminUid = req.user?.uid || "unknown-admin";

    try {
      if (!userId) {
        res.status(400).json({ success: false, message: "User ID parameter is required." });
        return;
      }

      if (!provider || (provider !== "flutterwave" && provider !== "squad")) {
        res.status(400).json({
          success: false,
          message: "A valid provider ('flutterwave' or 'squad') must be explicitly selected."
        });
        return;
      }

      logger.info(`[AdminController] Admin ${adminUid} approving KYC for user: ${userId} via provider: ${provider} | reqId=${reqId}`);

      const result = await KycService.approveKyc(userId, adminUid, `req-${reqId}-${Date.now()}`, provider);

      res.status(200).json({
        success: true,
        message: `User KYC successfully approved and static virtual account provisioned via ${provider}!`,
        data: result
      });
    } catch (error: any) {
      logger.error(`[AdminController] approveKycSubmission failure: ${error.message} | reqId=${reqId}`);
      res.status(400).json({
        success: false,
        message: error.message || "Failed to approve KYC verification."
      });
    }
  }

  /**
   * Reject a user's KYC submission securely.
   */
  public static async rejectKycSubmission(req: AuthenticatedRequest, res: Response): Promise<void> {
    const reqId = req.requestId;
    const { userId } = req.params;
    const { reason } = req.body;
    const adminUid = req.user?.uid || "unknown-admin";

    try {
      if (!userId) {
        res.status(400).json({ success: false, message: "User ID parameter is required." });
        return;
      }
      if (!reason || !reason.trim()) {
        res.status(400).json({ success: false, message: "Rejection reason is required." });
        return;
      }

      logger.info(`[AdminController] Admin ${adminUid} rejecting KYC for user: ${userId} | reason: ${reason} | reqId=${reqId}`);

      await KycService.rejectKyc(userId, adminUid, reason, `req-${reqId}-${Date.now()}`);

      res.status(200).json({
        success: true,
        message: "User KYC rejected and notification dispatched successfully."
      });
    } catch (error: any) {
      logger.error(`[AdminController] rejectKycSubmission failure: ${error.message} | reqId=${reqId}`);
      res.status(400).json({
        success: false,
        message: error.message || "Failed to reject KYC verification."
      });
    }
  }

  /**
   * Retry virtual account provisioning for a failed user
   */
  public static async retryKycProvisioning(req: AuthenticatedRequest, res: Response): Promise<void> {
    const reqId = req.requestId;
    const { userId } = req.params;
    const { provider } = req.body;
    const adminUid = req.user?.uid || "unknown-admin";

    try {
      if (!userId) {
        res.status(400).json({ success: false, message: "User ID parameter is required." });
        return;
      }

      if (!provider || (provider !== "flutterwave" && provider !== "squad")) {
        res.status(400).json({
          success: false,
          message: "A valid provider ('flutterwave' or 'squad') must be explicitly selected for retry."
        });
        return;
      }

      logger.info(`[AdminController] Admin ${adminUid} retrying KYC provisioning for user: ${userId} via provider: ${provider} | reqId=${reqId}`);

      const result = await KycService.retryProvisioning(userId, adminUid, `req-${reqId}-${Date.now()}`, provider);

      res.status(200).json({
        success: true,
        message: `Virtual account successfully provisioned on retry via ${provider}!`,
        data: result
      });
    } catch (error: any) {
      logger.error(`[AdminController] retryKycProvisioning failure: ${error.message} | reqId=${reqId}`);
      res.status(400).json({
        success: false,
        message: error.message || "Failed to retry provisioning."
      });
    }
  }

  /**
   * Manual bank synchronization triggering.
   * Pulls the latest bank list from Flutterwave and saves to Firestore banks collection in batches.
   */
  public static async syncBanks(req: Request, res: Response): Promise<void> {
    const reqId = req.requestId;
    try {
      const db = adminDb;
      if (!db) {
        res.status(500).json({ success: false, message: "Firestore database not configured." });
        return;
      }

      logger.info(`[AdminController] Syncing banks from Flutterwave... | reqId=${reqId}`);

      const client = getFlutterwaveClient();
      const response = await client.request("get", "/banks/NG");

      if (!response || response.status !== "success" || !Array.isArray(response.data)) {
        res.status(400).json({ success: false, message: "Failed to retrieve valid bank codes from Flutterwave API." });
        return;
      }

      const rawBanks = response.data;
      const nowStr = new Date().toISOString();
      const batchSize = 250;
      let batch = db.batch();
      let currentCount = 0;
      let totalSaved = 0;

      for (const bank of rawBanks) {
        if (!bank.code) continue;

        const bankId = bank.id?.toString() || bank.code.trim();
        const bankRef = db.collection("banks").doc(bankId);

        const bankDoc = {
          id: bankId,
          name: bank.name || "Unknown Bank",
          code: bank.code.trim(),
          country: bank.country || "NG",
          type: bank.type || "NG",
          is_active: bank.is_active !== undefined ? !!bank.is_active : true,
          createdAt: nowStr,
          updatedAt: nowStr,
        };

        batch.set(bankRef, bankDoc, { merge: true });
        currentCount++;
        totalSaved++;

        if (currentCount >= batchSize) {
          await batch.commit();
          batch = db.batch();
          currentCount = 0;
        }
      }

      if (currentCount > 0) {
        await batch.commit();
      }

      res.status(200).json({
        success: true,
        message: "Bank codes successfully synchronized from Flutterwave.",
        count: totalSaved,
      });
    } catch (error: any) {
      logger.error(`[AdminController] syncBanks exception: ${error.message} | reqId=${reqId}`);
      res.status(500).json({ success: false, message: "Failed to sync bank list.", error: error.message });
    }
  }
}
