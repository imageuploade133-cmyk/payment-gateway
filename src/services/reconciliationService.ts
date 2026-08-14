import { adminDb } from "../config/firebase";
import { getFlutterwaveClient } from "../providers/flutterwave";
import logger from "../config/logger";
import { FieldValue } from "firebase-admin/firestore";
import { ClubkonnectService } from "./clubkonnect.service";

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
      try {
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
            logger.info(`[Refund] User: ${userId}`);
            const userRef = adminDb!.collection("users").doc(userId);
            const userDoc = await transaction.get(userRef);

            if (!userDoc.exists) {
              throw new Error(`[Refund Error] User document not found for ID: ${userId}`);
            }

            const userData = userDoc.data() || {};
            const currentBalance = Number(userData.balance) || 0;
            logger.info(`[Refund] Current wallet balance: ₦${currentBalance}`);
            logger.info(`[Refund] Refund amount: ₦${totalRefund}`);

            const updatedBalance = currentBalance + totalRefund;

            // Increment wallet balance
            transaction.update(userRef, {
              balance: updatedBalance
            });
            logger.info(`[Refund] Updated wallet balance: ₦${updatedBalance}`);
            logger.info(`[Refund] Wallet document updated successfully`);

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
            logger.info(`[Refund] Transaction history created`);

            updatePayload.refundProcessed = true;
            updatePayload.refundProcessedAt = new Date().toISOString();
            updatePayload.refundReference = `REFUND-${reference}`;
            updatePayload.refunded = true;
            updatePayload.refundedAt = new Date().toISOString();
            refunded = true;
            refundTransactionCommitted = true;
          }

          transaction.update(transferRef, updatePayload);
        });

        if (refundTransactionCommitted) {
          logger.info(`[Refund] Refund transaction committed successfully`);
        }
      } catch (txErr: any) {
        logger.error(`[Refund Error] Refund transaction aborted | error=${txErr.message} | stack=${txErr.stack}`);
        throw txErr;
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
   * Reconciles a single VTU transaction by querying Clubkonnect and updating Firestore atomically.
   */
  public async reconcileSingleVtuTransaction(transactionRef: string): Promise<{ success: boolean; status?: string; message: string }> {
    logger.info(`[VTU Reconciliation] Reconciling VTU transaction: ${transactionRef}`);

    if (!adminDb) {
      return { success: false, message: "Firestore database is not initialized." };
    }

    // 1. Safe distributed lock setup via Firestore to prevent duplicate concurrent reconciliation
    const lockRef = adminDb!.collection("vtu_reconciliation_locks").doc(transactionRef);
    try {
      await adminDb!.runTransaction(async (transaction) => {
        const lockDoc = await transaction.get(lockRef);
        if (lockDoc.exists) {
          const lockData = lockDoc.data() || {};
          const expiresAt = new Date(lockData.expiresAt);
          if (expiresAt > new Date()) {
            throw new Error("Duplicate VTU reconciliation prevented.");
          }
        }

        // Set lock with 5-minute auto expiration for safety
        transaction.set(lockRef, {
          transactionRef,
          acquiredAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          workerId: process.env.pm_id || "default",
        });
      });
      logger.info(`[VTU Reconciliation] Worker acquired lock for VTU transaction: ${transactionRef}`);
    } catch (err: any) {
      if (err.message === "Duplicate VTU reconciliation prevented.") {
        logger.info(`[VTU Reconciliation] Duplicate reconciliation prevented for: ${transactionRef}`);
        return { success: false, message: "Duplicate reconciliation prevented." };
      }
      logger.error(`[VTU Reconciliation] Lock acquisition failed for VTU ${transactionRef}: ${err.message}`);
      return { success: false, message: `Failed to acquire lock: ${err.message}` };
    }

    try {
      const vtuTxRef = adminDb!.collection("vtu_transactions").doc(transactionRef);
      const vtuTxDoc = await vtuTxRef.get();

      if (!vtuTxDoc.exists) {
        logger.warn(`[VTU Reconciliation] VTU Transaction document not found for reference: ${transactionRef}`);
        return { success: false, message: `VTU Transaction document not found: ${transactionRef}` };
      }

      const vtuTxData = vtuTxDoc.data() || {};
      const currentVtuStatus = String(vtuTxData.status || "").trim().toUpperCase();

      // Skip processing if already in a terminal state
      if (currentVtuStatus === "DELIVERED" || currentVtuStatus === "FAILED" || currentVtuStatus === "REFUNDED") {
        logger.info(`[VTU Reconciliation] Transaction ${transactionRef} is already in a terminal state: ${currentVtuStatus}. Skipping.`);
        return { success: true, status: currentVtuStatus, message: `Already in terminal state: ${currentVtuStatus}` };
      }

      const userId = vtuTxData.userId;
      const amount = Number(vtuTxData.amount) || 0;
      const phone = vtuTxData.phone;
      const providerOrderId = vtuTxData.providerOrderId;
      const requestId = vtuTxData.requestId;

      // 2. Query Clubkonnect status
      let queryResult;
      try {
        queryResult = await ClubkonnectService.queryAirtimeTransaction({
          orderId: providerOrderId || undefined,
          requestId: requestId || undefined,
        });
      } catch (queryErr: any) {
        logger.error(`[VTU Reconciliation] Clubkonnect query failed for ${transactionRef}: ${queryErr.message}`);
        return { success: false, message: `Clubkonnect API query failed: ${queryErr.message}` };
      }

      if (!queryResult || !queryResult.success) {
        logger.warn(`[VTU Reconciliation] Clubkonnect query returned unsuccessful response for ${transactionRef}. Keeping Pending.`);
        return { success: true, status: "Pending", message: "Query returned unsuccessful." };
      }

      const providerStatus = String(queryResult.status || "").trim().toLowerCase();
      logger.info(`[VTU Reconciliation] Clubkonnect provider status for ${transactionRef}: ${providerStatus}`);

      let targetStatus: "Delivered" | "Failed" | "Pending" = "Pending";
      let isFailure = false;

      const successStatuses = ["delivered", "successful", "success", "order_completed", "completed"];
      const failureStatuses = ["failed", "cancelled", "refunded", "order_failed", "order_cancelled", "order_refunded", "rejected"];

      if (successStatuses.includes(providerStatus)) {
        targetStatus = "Delivered";
      } else if (failureStatuses.includes(providerStatus)) {
        targetStatus = "Failed";
        isFailure = true;
      } else {
        targetStatus = "Pending";
      }

      if (targetStatus === "Pending") {
        logger.info(`[VTU Reconciliation] VTU transaction ${transactionRef} status on Clubkonnect is still pending/processing. Keeping Pending.`);
        return { success: true, status: "Pending", message: "Transaction is still pending on provider side." };
      }

      const userDocRef = adminDb!.collection("users").doc(userId);
      const ledgerRef = adminDb!.collection("transactions").doc(`tx-${transactionRef}`);

      // 3. Atomically update transaction status and refund if failed (Idempotent single transaction)
      let refunded = false;
      await adminDb!.runTransaction(async (transaction) => {
        const freshVtuTx = await transaction.get(vtuTxRef);
        const freshData = freshVtuTx.data() || {};
        const freshStatus = String(freshData.status || "").trim().toUpperCase();

        if (freshStatus === "DELIVERED" || freshStatus === "FAILED" || freshStatus === "REFUNDED") {
          logger.info(`[VTU Reconciliation Transaction] Concurrent skip: terminal state ${freshStatus}`);
          return;
        }

        const updatePayload: Record<string, any> = {
          status: targetStatus,
          reconciledPayload: queryResult,
          reconciledAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        if (isFailure && !freshData.refundProcessed) {
          logger.info(`[VTU Reconciliation] Executing Reconciliation Refund | userId=${userId} | amount=₦${amount} | ref=${transactionRef}`);

          // Re-credit the wallet
          transaction.update(userDocRef, {
            balance: FieldValue.increment(amount)
          });

          // Update main general ledger record status to FAILED
          transaction.update(ledgerRef, {
            status: "FAILED",
            updatedAt: new Date().toISOString()
          });

          // Create refund general ledger ledger item
          const refundLedgerRef = adminDb!.collection("transactions").doc(`tx-REFUND-${transactionRef}`);
          transaction.set(refundLedgerRef, {
            userId,
            amount,
            currency: "NGN",
            reference: `REFUND-${transactionRef}`,
            type: "DEPOSIT",
            description: `Refund for failed ${freshData.type || "VTU"} transaction (Reconciliation): ${queryResult.remark || "Provider delivery failure"}`,
            recipientName: phone || "Self",
            status: "SUCCESS",
            date: new Date().toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" }),
            time: new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
            fee: 0,
            createdAt: new Date().toISOString(),
          });

          updatePayload.refundProcessed = true;
          updatePayload.refundProcessedAt = new Date().toISOString();
          refunded = true;
        } else {
          // Successful delivery update ledger status to SUCCESS
          transaction.update(ledgerRef, {
            status: "SUCCESS",
            updatedAt: new Date().toISOString()
          });
        }

        transaction.update(vtuTxRef, updatePayload);
      });

      logger.info(`[VTU Reconciliation] VTU transaction ${transactionRef}: provider_status=${providerStatus}, transaction_status=${currentVtuStatus} -> ${targetStatus}`);

      return {
        success: true,
        status: targetStatus,
        message: `Successfully reconciled VTU transaction. Status updated to ${targetStatus}.`,
      };

    } catch (error: any) {
      logger.error(`[VTU Reconciliation] Reconciliation crashed for VTU ${transactionRef}: ${error.message}`);
      return { success: false, message: `Reconciliation exception: ${error.message}` };
    } finally {
      // 4. Always release the lock
      try {
        await lockRef.delete();
      } catch (deleteErr: any) {
        logger.error(`[VTU Reconciliation] Failed to release lock for reference: ${transactionRef} | ${deleteErr.message}`);
      }
    }
  }

  /**
   * Scans and reconciles all pending VTU transactions.
   */
  public async reconcilePendingVtuTransactions(): Promise<void> {
    if (!adminDb) return;

    try {
      const pendingVtuSnap = await adminDb!.collection("vtu_transactions").where("status", "==", "Pending").get();
      if (pendingVtuSnap.empty) {
        logger.info("[VTU Reconciliation] No pending VTU transactions found to reconcile.");
        return;
      }

      logger.info(`[VTU Reconciliation] Found ${pendingVtuSnap.size} pending VTU transactions. Starting reconciliation...`);

      for (const doc of pendingVtuSnap.docs) {
        const transactionRef = doc.id;
        await this.reconcileSingleVtuTransaction(transactionRef);
      }
    } catch (err: any) {
      logger.error(`[VTU Reconciliation] Failed to scan pending VTU transactions: ${err.message}`);
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
        if (!pendingSnap.empty) {
          logger.info(`[Reconciliation Service] Found ${pendingSnap.size} pending transfers. Starting reconciliation...`);
          for (const doc of pendingSnap.docs) {
            const reference = doc.id;
            await this.reconcileSingleTransfer(reference);
          }
        } else {
          logger.info("[Reconciliation Service] No pending transfers found to reconcile.");
        }

        // Reconcile pending VTU transactions
        await this.reconcilePendingVtuTransactions();

      } catch (err: any) {
        logger.error(`[Reconciliation Service] Background loop failed: ${err.message}`);
      }
    }, 60 * 1000);
  }
}
