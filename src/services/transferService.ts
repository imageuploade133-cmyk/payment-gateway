import { getFlutterwaveClient } from "../providers/flutterwave";
import logger from "../config/logger";
import { FirestoreIdempotency } from "./firestoreIdempotency";
import { adminDb } from "../config/firebase";

export interface IdempotencyProvider {
  isDuplicate(reference: string): Promise<boolean>;
  saveReference(reference: string): Promise<void>;
}

export class InMemoryIdempotency implements IdempotencyProvider {
  private static instance: InMemoryIdempotency;
  public cache = new Set<string>();
  private insertionOrder: string[] = [];
  private maxKeys = 10000; // Strictly bound cache to 10k items to prevent boundless memory growth

  private constructor() {}

  public static getInstance(): InMemoryIdempotency {
    if (!InMemoryIdempotency.instance) {
      InMemoryIdempotency.instance = new InMemoryIdempotency();
    }
    return InMemoryIdempotency.instance;
  }

  public async isDuplicate(reference: string): Promise<boolean> {
    return this.cache.has(reference);
  }

  public async saveReference(reference: string): Promise<void> {
    if (this.cache.has(reference)) return;
    if (this.cache.size >= this.maxKeys) {
      const oldest = this.insertionOrder.shift();
      if (oldest) {
        this.cache.delete(oldest);
      }
    }
    this.cache.add(reference);
    this.insertionOrder.push(reference);
  }
}

export interface InitiateTransferParams {
  amount: number;
  account_number: string;
  bank_code: string;
  account_name: string;
  currency: string;
  narration: string;
  reference: string;
  requestId: string;
  userId?: string;
  fee?: number;
}

export interface TransferResult {
  success: boolean;
  processing?: boolean;
  reference: string;
  provider_reference?: string;
  status: "success" | "pending" | "failed";
  message?: string;
  flutterwaveStatus?: string;
}

export class TransferService {
  private idempotencyProvider: IdempotencyProvider;

  constructor(idempotencyProvider: IdempotencyProvider = FirestoreIdempotency.getInstance()) {
    this.idempotencyProvider = idempotencyProvider;
  }

  /**
   * Executes a transfer to a bank account using Flutterwave.
   */
  public async executeTransfer(params: InitiateTransferParams): Promise<TransferResult> {
    const { amount, account_number, bank_code, account_name, currency, narration, reference, requestId, userId } = params;

    logger.info(
      `[TransferService] Starting transfer process | reference=${reference} | amount=${amount} | account=${account_number} | reqId=${requestId}`
    );

    // 1. Idempotency Check
    const isDuplicate = await this.idempotencyProvider.isDuplicate(reference);
    if (isDuplicate) {
      logger.warn(
        `[TransferService] Duplicate transaction reference detected | reference=${reference} | reqId=${requestId}`
      );
      return {
        success: false,
        reference,
        status: "failed",
        message: "Duplicate transfer reference. This transaction has already been initiated.",
      };
    }



    try {
      const client = getFlutterwaveClient();

      const payload = {
        account_bank: bank_code,
        account_number,
        amount,
        narration,
        currency,
        reference,
        callback_url: undefined,
      };

      logger.info(
        `[TransferService] Payload sent to Flutterwave | reference=${reference} | payload=${JSON.stringify(payload)} | reqId=${requestId}`
      );

      const response = await client.request("post", "/transfers", payload);

      logger.info(
        `[TransferService] Flutterwave raw transfer response received | reference=${reference} | response=${JSON.stringify(response)} | reqId=${requestId}`
      );

      if (response && response.status === "success" && response.data) {
        const flwId = response.data.id?.toString();
        const flwStatus = (response.data.status?.toLowerCase() || "new");

        logger.info(
          `[TransferService] Transfer successfully accepted by Flutterwave | reference=${reference} | flwId=${flwId} | status=${flwStatus} | reqId=${requestId}`
        );

        // Update status and provider reference in Firestore idempotency log
        const dbStatus = (flwStatus === "successful" || flwStatus === "success")
          ? "success"
          : (flwStatus === "failed" ? "failed" : "pending");

        if (typeof (this.idempotencyProvider as any).saveReference === "function") {
          await (this.idempotencyProvider as any).saveReference(reference, "flutterwave", dbStatus, flwId);
        }

        // Save immediately to Firestore transfers collection
        if (adminDb) {
          try {
            await adminDb.collection("transfers").doc(reference).set({
              transferReference: reference,
              flutterwaveTransferId: flwId || null,
              providerTransferId: flwId || null,
              reference: reference,
              userId: userId || "N/A",
              amount: amount,
              fee: params.fee || 10.00,
              bankCode: bank_code,
              accountNumber: account_number,
              recipientName: account_name,
              recipient: {
                account_number,
                bank_code,
                account_name,
              },
              status: "PENDING",
              flutterwaveStatus: flwStatus,
              createdAt: new Date().toISOString(),
            });
            logger.info(`[TransferService] Firestore save successful for transfer collection reference: ${reference}`);
          } catch (fsError: any) {
            logger.error(`[TransferService] Firestore save failed for transfers collection reference: ${reference} | error=${fsError.message}`);
          }
        }

        const isProcessing = flwStatus === "new" || flwStatus === "pending";

        return {
          success: true,
          processing: isProcessing,
          reference,
          provider_reference: flwId,
          status: dbStatus,
          flutterwaveStatus: flwStatus,
          message: response.message || "Transfer initiated successfully.",
        };
      }

      logger.error(
        `[TransferService] Unexpected response structure from provider | reference=${reference} | reqId=${requestId}`
      );
      return {
        success: false,
        reference,
        status: "failed",
        message: "The payment provider returned an unexpected response.",
      };

    } catch (error: any) {
      const errorMsg = error.message || "Unknown provider error";
      logger.error(
        `[TransferService] Transfer failed on provider rail | reference=${reference} | error=${errorMsg} | reqId=${requestId}`
      );

      // Update status as failed inside Firestore
      if (typeof (this.idempotencyProvider as any).saveReference === "function") {
        await (this.idempotencyProvider as any).saveReference(reference, "flutterwave", "failed");
      }

      return {
        success: false,
        reference,
        status: "failed",
        message: "Transfer could not be processed. Please check account details or try again later.",
      };
    }
  }
}
