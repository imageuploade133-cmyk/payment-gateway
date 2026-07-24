import { adminDb } from "../config/firebase";
import { getFlutterwaveClient } from "../providers/flutterwave";
import logger from "../config/logger";
import { FieldValue } from "firebase-admin/firestore";

export class ReconciliationService {
  private static instance: ReconciliationService;

  private constructor() {}

  public static getInstance(): ReconciliationService {
    if (!ReconciliationService.instance) {
      ReconciliationService.instance = new ReconciliationService();
    }
    return ReconciliationService.instance;
  }

  /**
   * Reconciles a single transfer by querying Flutterwave and updating Firestore atomically.
   */
  public async reconcileSingleTransfer(reference: string): Promise<{ success: boolean; status?: string; message: string; refunded?: boolean }> {
    logger.info(`[Reconciliation Service] Reconciling transfer reference: ${reference}`);

    if (!adminDb) {
      return { success: false, message: "Firestore database is not initialized." };
    }

    // 1. Safe distributed lock setup via Firestore to prevent duplicate concurrent reconciliation under PM2
    const lockRef = adminDb.collection("reconciliation_locks").doc(reference);
    try {
      await adminDb.runTransaction(async (transaction) => {
        const lockDoc = await transaction.get(lockRef);
        if (lockDoc.exists) {
          const lockData = lockDoc.data() || {};
          const expiresAt = new Date(lockData.expiresAt);
          if (expiresAt > new Date()) {
            throw new Error("Duplicate reconciliation prevented.");
          }
        }

        // Set lock with 5-minute auto expiration for safety
        transaction.set(lockRef, {
          reference,
          acquiredAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          workerId: process.env.pm_id || "default",
        });
      });
      logger.info(`[Reconciliation Service] Worker acquired reconciliation lock for reference: ${reference}`);
    } catch (err: any) {
      if (err.message === "Duplicate reconciliation prevented.") {
        logger.info(`[Reconciliation Service] Duplicate reconciliation prevented for reference: ${reference}`);
        return { success: false, message: "Duplicate reconciliation prevented." };
      }
      logger.error(`[Reconciliation Service] Lock acquisition failed for ${reference}: ${err.message}`);
      return { success: false, message: `Failed to acquire lock: ${err.message}` };
    }

    try {
      const transferRef = adminDb!.collection("transfers").doc(reference);
      const transferDoc = await transferRef.get();

      if (!transferDoc.exists) {
        logger.warn(`[Reconciliation Service] Transfer document not found for reference: ${reference}`);
        return { success: false, message: `Transfer document not found: ${reference}` };
      }

      const transferData = transferDoc.data() || {};
      const currentStatus = transferData.status || "PENDING";

      // If already terminal/refunded, skip immediately to ensure idempotency
      if (transferData.refundProcessed || transferData.refunded) {
        logger.info(`[Reconciliation Service] Refund already processed. Skipping.`);
        return { success: true, status: currentStatus, refunded: true, message: "Refund already processed. Skipping." };
      }

      if (currentStatus === "SUCCESS" || currentStatus === "FAILED" || currentStatus === "REVERSED") {
        logger.info(`[Reconciliation Service] Transfer ${reference} is already in a terminal state: ${currentStatus}. Skipping.`);
        return { success: true, status: currentStatus, message: `Already in terminal state: ${currentStatus}` };
      }

      // 2. Query Flutterwave status directly by reference
      const client = getFlutterwaveClient();
      let flwStatus: string | undefined;
      let flwId: string | undefined;
      let failureReason: string | undefined;

      try {
        const response = await client.request("get", `/transfers?reference=${reference}`);
        logger.info(`[Reconciliation Service] Flutterwave API response for ${reference}: ${JSON.stringify(response)}`);

        if (response && response.status === "success" && Array.isArray(response.data) && response.data.length > 0) {
          const trans = response.data[0];
          flwStatus = trans.status?.toUpperCase(); // "SUCCESSFUL", "FAILED", "REVERSED", etc.
          flwId = trans.id?.toString();
          failureReason = trans.complete_message || trans.reason || null;
        }
      } catch (flwErr: any) {
        logger.error(`[Reconciliation Service] Flutterwave query failed for reference ${reference}: ${flwErr.message}`);
        return { success: false, message: `Flutterwave API query failed: ${flwErr.message}` };
      }

      if (!flwStatus) {
        logger.warn(`[Reconciliation Service] Flutterwave status not found for reference: ${reference}. Keeping PENDING.`);
        return { success: true, status: "PENDING", message: "Status not found on Flutterwave rails yet." };
      }

      // Map Flutterwave status to local statuses
      let mappedStatus: "PENDING" | "SUCCESS" | "FAILED" | "REVERSED" = "PENDING";
      if (flwStatus === "SUCCESSFUL" || flwStatus === "SUCCESS" || flwStatus === "COMPLETED") {
        mappedStatus = "SUCCESS";
      } else if (flwStatus === "FAILED" || flwStatus === "ERROR" || flwStatus === "REVERSED" || flwStatus === "INSUFFICIENT_FUNDS") {
        mappedStatus = "FAILED";
      } else {
        mappedStatus = "PENDING";
      }

      logger.info(`[Reconciliation Service] Status mapped for ${reference}: ${currentStatus} -> ${mappedStatus}`);

      if (mappedStatus === "PENDING") {
        return { success: true, status: "PENDING", message: "Transfer is still pending on Flutterwave rails." };
      }

      let refunded = false;
      let refundTransactionCommitted = false;

      // 3. Perform atomic Firestore Transaction for state transition & refund
      await adminDb!.runTransaction(async (transaction) => {
        const freshDoc = await transaction.get(transferRef);
        const freshData = freshDoc.data() || {};
        const freshStatus = freshData.status || "PENDING";

        // Double check refund and status inside the transaction to absolutely prevent race conditions
        if (freshData.refundProcessed || freshData.refunded) {
          logger.info(`[Reconciliation Service] Refund already processed. Skipping.`);
          return;
        }

        if (freshStatus === "SUCCESS" || freshStatus === "FAILED" || freshStatus === "REVERSED") {
          logger.info(`[Reconciliation Service] Transaction concurrent skip: Already terminal state: ${freshStatus}`);
          return;
        }

        const userId = freshData.userId;
        const amount = Number(freshData.amount) || 0;
        const fee = Number(freshData.fee) || 0;
        const totalRefund = amount + fee;

        const updatePayload: Record<string, any> = {
          status: mappedStatus,
          flutterwaveStatus: flwStatus,
          providerStatus: flwStatus,
          providerTransferId: flwId || null,
          failureReason: failureReason || null,
          reconciledAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };

        if (mappedStatus === "FAILED" && userId && userId !== "N/A") {
          logger.info(`[Reconciliation Service] Transfer FAILED for reference: ${reference}. Triggering wallet refund.`);
          const userRef = adminDb!.collection("users").doc(userId);
          const userDoc = await transaction.get(userRef);

          if (userDoc.exists) {
            // Increment balance
            transaction.update(userRef, {
              balance: FieldValue.increment(totalRefund)
            });

            // Write refund ledger transaction record
            const ledgerRef = adminDb!.collection("transactions").doc(`tx-REFUND-${reference}`);
            transaction.set(ledgerRef, {
              userId,
              amount: totalRefund,
              currency: "NGN",
              reference: `REFUND-${reference}`,
              type: "DEPOSIT",
              description: `Reconciliation Refund for failed transfer: ${freshData.description || `Transfer to ${freshData.recipientName}`}`,
              recipientName: freshData.recipientName || "Self",
              status: "SUCCESS",
              date: new Date().toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" }),
              time: new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
              fee: 0,
              createdAt: new Date().toISOString(),
            });

            updatePayload.refundProcessed = true;
            updatePayload.refundProcessedAt = new Date().toISOString();
            updatePayload.refundReference = `REFUND-${reference}`;
            updatePayload.refunded = true;
            updatePayload.refundedAt = new Date().toISOString();
            refunded = true;
            refundTransactionCommitted = true;
          } else {
            logger.error(`[Reconciliation Refund Error] User document not found for user: ${userId}`);
          }
        }

        transaction.update(transferRef, updatePayload);
      });

      if (refundTransactionCommitted) {
        logger.info(`[Reconciliation Service] Refund transaction committed successfully for reference: ${reference}`);
      }

      return {
        success: true,
        status: mappedStatus,
        refunded,
        message: `Successfully reconciled transfer. Status updated to ${mappedStatus}.`
      };

    } catch (error: any) {
      logger.error(`[Reconciliation Service] Reconciliation crashed for ${reference}: ${error.message}`);
      return { success: false, message: `Reconciliation exception: ${error.message}` };
    } finally {
      // 4. Always release the lock for this reference
      try {
        await lockRef.delete();
      } catch (deleteErr: any) {
        logger.error(`[Reconciliation Service] Failed to release lock for reference: ${reference} | ${deleteErr.message}`);
      }
    }
  }

  /**
   * Starts the background cron-like service that runs every 60 seconds.
   */
  public startAutomatedReconciliation(): void {
    const pmId = process.env.pm_id || process.env.NODE_APP_INSTANCE;
    // Only run automated reconciliation background scans on instance "0" under PM2 (or outside PM2)
    if (pmId !== undefined && pmId !== "0") {
      logger.info(`[Reconciliation Service] PM2 Instance ${pmId} skipping automated background reconciliation scan loop (only instance 0 runs it).`);
      return;
    }

    logger.info("[Reconciliation Service] Initializing 60-second automated transfer reconciliation loop...");

    setInterval(async () => {
      logger.info("[Reconciliation Service] Starting 60-second background status reconciliation scan...");

      if (!adminDb) {
        logger.warn("[Reconciliation Service] Firestore is offline. Skipping background scan.");
        return;
      }

      try {
        const pendingSnap = await adminDb!.collection("transfers").where("status", "==", "PENDING").get();
        if (pendingSnap.empty) {
          logger.info("[Reconciliation Service] No pending transfers found to reconcile.");
          return;
        }

        logger.info(`[Reconciliation Service] Found ${pendingSnap.size} pending transfers. Starting reconciliation...`);

        for (const doc of pendingSnap.docs) {
          const reference = doc.id;
          await this.reconcileSingleTransfer(reference);
        }

      } catch (err: any) {
        logger.error(`[Reconciliation Service] Background loop failed: ${err.message}`);
      }
    }, 60 * 1000);
  }
}
