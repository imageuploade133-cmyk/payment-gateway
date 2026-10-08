import { adminDb } from "../config/firebase";
import { IdempotencyProvider, InMemoryIdempotency } from "./transferService";
import logger from "../config/logger";

const WEBHOOK_LEASE_DURATION_MS = 60 * 1000; // 60-second processing lease

export class FirestoreIdempotency implements IdempotencyProvider {
  private static instance: FirestoreIdempotency;
  private memoryFallback = InMemoryIdempotency.getInstance();

  private constructor() {}

  public static getInstance(): FirestoreIdempotency {
    if (!FirestoreIdempotency.instance) {
      FirestoreIdempotency.instance = new FirestoreIdempotency();
    }
    return FirestoreIdempotency.instance;
  }

  /**
   * Atomically claims a transfer reference before any provider call.
   * Returns true only when this process owns the reference reservation.
   */
  public async claimReference(reference: string, provider = "flutterwave"): Promise<boolean> {
    if (!adminDb) {
      logger.error(`[Idempotency] Firestore unavailable; refusing financial provider call for reference: ${reference}`);
      return false;
    }

    try {
      const docRef = adminDb.collection("gateway_idempotency_references").doc(reference);
      let claimed = false;

      await adminDb.runTransaction(async (transaction) => {
        const doc = await transaction.get(docRef);
        if (doc.exists) return;

        transaction.create(docRef, {
          provider,
          reference,
          provider_reference: null,
          timestamp: new Date().toISOString(),
          status: "pending",
        });
        claimed = true;
      });

      if (!claimed) {
        logger.warn(`[Idempotency] Atomic duplicate/reservation hit: ${reference}`);
      }
      return claimed;
    } catch (error: any) {
      logger.error(`[Idempotency] Atomic reference claim failed: ${error.message}`);
      return false;
    }
  }

  /**
   * Legacy read-only duplicate check retained for compatibility.
   */
  public async isDuplicate(reference: string): Promise<boolean> {
    if (!adminDb) {
      return this.memoryFallback.isDuplicate(reference);
    }

    try {
      const doc = await adminDb.collection("gateway_idempotency_references").doc(reference).get();
      return doc.exists || await this.memoryFallback.isDuplicate(reference);
    } catch (error: any) {
      logger.error(`[Idempotency] Firestore duplicate read failed: ${error.message}`);
      return true;
    }
  }

  /**
   * Updates the already-claimed reference with provider outcome.
   */
  public async saveReference(reference: string, provider = "flutterwave", status = "pending", providerReference?: string): Promise<void> {
    await this.memoryFallback.saveReference(reference);

    if (!adminDb) {
      logger.warn(`[Idempotency] Firestore unavailable while updating reference: ${reference}`);
      return;
    }

    try {
      const docRef = adminDb.collection("gateway_idempotency_references").doc(reference);
      await docRef.set({
        provider,
        reference,
        provider_reference: providerReference || null,
        timestamp: new Date().toISOString(),
        status,
      }, { merge: true });
    } catch (error: any) {
      logger.error(`[Idempotency] Reference update failed: ${error.message}`);
    }
  }

  /**
   * Atomically claims or reclaims a webhook event before processing it.
   * Returns false when this process successfully claims/reclaims the event reservation.
   * Returns true when the event is already PROCESSED or currently locked under an active lease.
   */
  public async isWebhookDuplicate(transactionId: string): Promise<boolean> {
    if (!adminDb) {
      logger.error(`[Idempotency] Firestore unavailable; refusing webhook processing: ${transactionId}`);
      return true;
    }

    try {
      const docRef = adminDb.collection("gateway_processed_webhooks").doc(transactionId);
      let duplicate = true;

      await adminDb.runTransaction(async (transaction) => {
        const doc = await transaction.get(docRef);
        const now = Date.now();
        const nowIso = new Date(now).toISOString();
        const leaseExpiresAt = new Date(now + WEBHOOK_LEASE_DURATION_MS).toISOString();

        if (!doc.exists) {
          transaction.create(docRef, {
            provider: "flutterwave",
            transactionId,
            eventType: "processing",
            timestamp: nowIso,
            leaseExpiresAt,
            status: "PROCESSING",
          });
          duplicate = false;
          return;
        }

        const data = doc.data() || {};
        const status = data.status || "PROCESSING";

        // Terminal PROCESSED status is permanently duplicate
        if (status === "PROCESSED") {
          duplicate = true;
          return;
        }

        // Active lease check for PROCESSING or PROCESSING_FAILED
        const existingLeaseTime = data.leaseExpiresAt ? new Date(data.leaseExpiresAt).getTime() : 0;
        const isLeaseExpired = now >= existingLeaseTime;

        if (isLeaseExpired) {
          // Reclaim stale/expired lease atomically
          transaction.set(docRef, {
            provider: "flutterwave",
            transactionId,
            eventType: "processing",
            timestamp: nowIso,
            leaseExpiresAt,
            status: "PROCESSING",
            reclaimedAt: nowIso,
            reclaimCount: (data.reclaimCount || 0) + 1,
          }, { merge: true });
          duplicate = false;
        } else {
          // Active lease in progress by another worker
          duplicate = true;
        }
      });

      return duplicate;
    } catch (error: any) {
      logger.error(`[Idempotency] Atomic webhook claim failed: ${error.message}`);
      return true;
    }
  }

  /**
   * Immediately releases an active webhook processing lease if processing failed due to a temporary error.
   */
  public async releaseWebhookProcessing(transactionId: string): Promise<void> {
    if (!adminDb || !transactionId) return;

    try {
      const docRef = adminDb.collection("gateway_processed_webhooks").doc(transactionId);
      await docRef.set({
        status: "PROCESSING_FAILED",
        leaseExpiresAt: new Date(0).toISOString(), // Expire immediately to allow retry
        failedAt: new Date().toISOString(),
      }, { merge: true });
    } catch (error: any) {
      logger.error(`[Idempotency] Release webhook processing failed: ${error.message}`);
    }
  }

  /**
   * Finalizes a previously claimed webhook event.
   */
  public async saveWebhookProcessed(transactionId: string, eventType = "charge.completed", provider = "flutterwave"): Promise<void> {
    await this.memoryFallback.saveReference(`wh-${transactionId}`);

    if (!adminDb) return;

    try {
      await adminDb.collection("gateway_processed_webhooks").doc(transactionId).set({
        provider,
        transactionId,
        eventType,
        timestamp: new Date().toISOString(),
        leaseExpiresAt: null,
        status: "PROCESSED",
      }, { merge: true });
    } catch (error: any) {
      logger.error(`[Idempotency] Webhook finalization failed: ${error.message}`);
    }
  }
}

export default FirestoreIdempotency;
