import { getFlutterwaveClient } from "../providers/flutterwave";
import logger from "../config/logger";
import { FirestoreIdempotency } from "./firestoreIdempotency";

export interface IdempotencyProvider {
  isDuplicate(reference: string): Promise<boolean>;
  saveReference(reference: string): Promise<void>;
}

export class InMemoryIdempotency implements IdempotencyProvider {
  private static instance: InMemoryIdempotency;
  public cache = new Set<string>();

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
    this.cache.add(reference);
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
}

export interface TransferResult {
  success: boolean;
  reference: string;
  provider_reference?: string;
  status: "success" | "pending" | "failed";
  message?: string;
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
    const { amount, account_number, bank_code, account_name, currency, narration, reference, requestId } = params;

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

    // Save reference immediately as pending to defend against high-frequency race conditions
    await this.idempotencyProvider.saveReference(reference);

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

      const response = await client.request("post", "/transfers", payload);

      if (response && response.status === "success" && response.data) {
        const flwId = response.data.id?.toString();
        const flwStatus = response.data.status?.toLowerCase();

        logger.info(
          `[TransferService] Transfer successfully accepted by Flutterwave | reference=${reference} | flwId=${flwId} | status=${flwStatus} | reqId=${requestId}`
        );

        // Update status and provider reference in Firestore idempotency log
        if (typeof (this.idempotencyProvider as any).saveReference === "function") {
          await (this.idempotencyProvider as any).saveReference(reference, "flutterwave", flwStatus === "successful" ? "success" : "pending", flwId);
        }

        return {
          success: true,
          reference,
          provider_reference: flwId,
          status: flwStatus === "successful" ? "success" : flwStatus === "failed" ? "failed" : "pending",
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
