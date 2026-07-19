import { adminDb } from "../config/firebase";
import { IdempotencyProvider, InMemoryIdempotency } from "./transferService";
import logger from "../config/logger";

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
   * Verifies if a transfer/transaction reference is already processed (Idempotency Check)
   */
  public async isDuplicate(reference: string): Promise<boolean> {
    if (!adminDb) {
      logger.warn(`[Idempotency] Firestore offline. Falling back to memory check for reference: ${reference}`);
      return this.memoryFallback.isDuplicate(reference);
    }

    try {
      const docRef = adminDb.collection("gateway_idempotency_references").doc(reference);
      const doc = await docRef.get();

      if (doc.exists) {
        logger.warn(`[Idempotency] Firestore duplicate hit detected for reference: ${reference}`);
        return true;
      }

      return this.memoryFallback.isDuplicate(reference);

    } catch (error: any) {
      logger.error(`[Idempotency Exception] Firestore read failed: ${error.message}. Falling back to memory.`);
      return this.memoryFallback.isDuplicate(reference);
    }
  }

  /**
   * Securely persists the reference inside Firestore collection with audit parameters.
   */
  public async saveReference(reference: string, provider = "flutterwave", status = "pending", providerReference?: string): Promise<void> {
    await this.memoryFallback.saveReference(reference);

    if (!adminDb) {
      logger.warn(`[Idempotency] Firestore offline. Persisted reference in memory only: ${reference}`);
      return;
    }

    try {
      const docRef = adminDb.collection("gateway_idempotency_references").doc(reference);

      // Perform atomic Firestore write
      await docRef.set({
        provider,
        reference,
        provider_reference: providerReference || null,
        timestamp: new Date().toISOString(),
        status,
      });

      logger.info(`[Idempotency] Successfully stored reference in Firestore: ${reference}`);

    } catch (error: any) {
      logger.error(`[Idempotency Exception] Firestore write failed: ${error.message}. Saved in memory only.`);
    }
  }

  /**
   * Verifies if a Webhook Event ID / transaction ID has already been handled.
   */
  public async isWebhookDuplicate(transactionId: string): Promise<boolean> {
    if (!adminDb) {
      logger.warn(`[Idempotency] Firestore offline. Checking webhook in memory only: ${transactionId}`);
      return this.memoryFallback.isDuplicate(`wh-${transactionId}`);
    }

    try {
      const docRef = adminDb.collection("gateway_processed_webhooks").doc(transactionId);
      const doc = await docRef.get();

      if (doc.exists) {
        logger.warn(`[Idempotency] Webhook already processed inside Firestore: ${transactionId}`);
        return true;
      }

      return this.memoryFallback.isDuplicate(`wh-${transactionId}`);

    } catch (error: any) {
      logger.error(`[Idempotency Exception] Firestore webhook read failed: ${error.message}. Falling back to memory.`);
      return this.memoryFallback.isDuplicate(`wh-${transactionId}`);
    }
  }

  /**
   * Persists a processed Webhook Event ID atomically.
   */
  public async saveWebhookProcessed(transactionId: string, eventType = "charge.completed", provider = "flutterwave"): Promise<void> {
    await this.memoryFallback.saveReference(`wh-${transactionId}`);

    if (!adminDb) {
      logger.warn(`[Idempotency] Firestore offline. Persisted webhook in memory only: ${transactionId}`);
      return;
    }

    try {
      const docRef = adminDb.collection("gateway_processed_webhooks").doc(transactionId);

      await docRef.set({
        provider,
        transactionId,
        eventType,
        timestamp: new Date().toISOString(),
      });

      logger.info(`[Idempotency] Successfully stored processed webhook in Firestore: ${transactionId}`);

    } catch (error: any) {
      logger.error(`[Idempotency Exception] Firestore webhook write failed: ${error.message}.`);
    }
  }
}
export default FirestoreIdempotency;
