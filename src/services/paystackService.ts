import { getPaystackClient } from "../providers/paystack";
import { FirestoreIdempotency } from "./firestoreIdempotency";
import logger from "../config/logger";

export interface PaystackResolveParams {
  account_number: string;
  bank_code: string;
  requestId: string;
}

export interface PaystackTransferParams {
  amount: number;
  account_number: string;
  bank_code: string;
  account_name: string;
  currency: string;
  narration: string;
  reference: string;
  requestId: string;
}

export interface PaystackVerifyParams {
  transaction_id: string;
  requestId: string;
}

export class PaystackService {
  /**
   * Resolves a bank account details using Paystack.
   */
  public static async resolveAccount(params: PaystackResolveParams) {
    const { account_number, bank_code, requestId } = params;
    logger.info(`[PaystackService] Resolving bank account | account=${account_number} | bank=${bank_code} | reqId=${requestId}`);

    try {
      const client = getPaystackClient();
      const response = await client.request("get", `/bank/resolve?account_number=${account_number}&bank_code=${bank_code}`);

      if (response && response.status && response.data) {
        return {
          success: true,
          account_name: response.data.account_name,
          account_number,
          bank_code,
        };
      }

      return { success: false, message: "Failed to resolve account details via Paystack." };
    } catch (error: any) {
      logger.error(`[PaystackService] Resolution failed | error=${error.message} | reqId=${requestId}`);
      return {
        success: false,
        message: "Unable to verify account details. Please check the bank and account number.",
      };
    }
  }

  /**
   * Executes outward bank transfers with multi-step recipient creation and idempotency protection.
   */
  public static async executeTransfer(params: PaystackTransferParams) {
    const { amount, account_number, bank_code, account_name, currency, narration, reference, requestId } = params;
    logger.info(`[PaystackService] Executing transfer | reference=${reference} | amount=${amount} | reqId=${requestId}`);

    const idempotency = FirestoreIdempotency.getInstance();
    const isDup = await idempotency.isDuplicate(reference);
    if (isDup) {
      logger.warn(`[PaystackService] Duplicate reference detected: ${reference} | reqId=${requestId}`);
      return {
        success: false,
        reference,
        status: "failed",
        message: "Duplicate transfer reference. This transaction has already been initiated.",
      };
    }

    await idempotency.saveReference(reference, "paystack");

    try {
      const client = getPaystackClient();

      // Step 1: Create Transfer Recipient
      logger.info(`[PaystackService] Creating transfer recipient | account=${account_number} | reqId=${requestId}`);
      const recipientRes = await client.request("post", "/transferrecipient", {
        type: "nuban",
        name: account_name,
        account_number,
        bank_code,
        currency: "NGN",
      });

      if (!recipientRes || !recipientRes.status || !recipientRes.data) {
        throw new Error(recipientRes?.message || "Failed to create transfer recipient profile.");
      }

      const recipientCode = recipientRes.data.recipient_code;

      // Step 2: Dispatch Payout Transfer
      logger.info(`[PaystackService] Dispatching payout | recipient=${recipientCode} | reqId=${requestId}`);
      const transferRes = await client.request("post", "/transfer", {
        source: "balance",
        amount: Math.round(amount * 100), // Convert to kobo
        recipient: recipientCode,
        reason: narration,
        reference,
      });

      if (transferRes && transferRes.status && transferRes.data) {
        const providerRef = transferRes.data.reference || transferRes.data.id?.toString();
        const pstkStatus = transferRes.data.status?.toLowerCase();

        await idempotency.saveReference(reference, "paystack", pstkStatus === "success" ? "success" : "pending", providerRef);

        return {
          success: true,
          reference,
          provider_reference: providerRef,
          status: pstkStatus === "success" ? "success" : pstkStatus === "failed" ? "failed" : "pending",
          message: transferRes.message || "Transfer initiated successfully.",
        };
      }

      return {
        success: false,
        reference,
        status: "failed",
        message: "Paystack transfer routing returned unexpected response.",
      };

    } catch (error: any) {
      logger.error(`[PaystackService] Transfer failed | reference=${reference} | error=${error.message} | reqId=${requestId}`);
      await idempotency.saveReference(reference, "paystack", "failed");
      return {
        success: false,
        reference,
        status: "failed",
        message: "Transfer could not be processed. Please check details or try again later.",
      };
    }
  }

  /**
   * Verifies a transaction reference status directly with Paystack.
   */
  public static async verifyTransaction(params: PaystackVerifyParams) {
    const { transaction_id, requestId } = params;
    logger.info(`[PaystackService] Verifying transaction | ref=${transaction_id} | reqId=${requestId}`);

    try {
      const client = getPaystackClient();
      const response = await client.request("get", `/transaction/verify/${transaction_id}`);

      if (response && response.status && response.data) {
        const txData = response.data;
        const pstkStatus = txData.status?.toLowerCase();

        return {
          success: pstkStatus === "success",
          status: pstkStatus === "success" ? "successful" : pstkStatus === "failed" ? "failed" : "pending",
          amount: Number(txData.amount) / 100 || 0, // Convert from kobo to standard NGN
          currency: txData.currency || "NGN",
          reference: txData.reference,
          provider_id: txData.id?.toString(),
          customer: {
            name: `${txData.customer?.first_name || ""} ${txData.customer?.last_name || ""}`.trim() || "Customer",
            email: txData.customer?.email || "customer@e-tech-hub.com",
            phone: txData.customer?.phone || undefined,
          },
        };
      }

      return {
        success: false,
        status: "pending",
        amount: 0,
        currency: "NGN",
        reference: "",
        provider_id: transaction_id,
        customer: { name: "", email: "" },
        message: "The payment verification payload returned unexpected results.",
      };

    } catch (error: any) {
      logger.error(`[PaystackService] Verification failed | ref=${transaction_id} | error=${error.message} | reqId=${requestId}`);
      return {
        success: false,
        status: "failed",
        amount: 0,
        currency: "NGN",
        reference: "",
        provider_id: transaction_id,
        customer: { name: "", email: "" },
        message: "Failed to verify transaction status with Paystack.",
      };
    }
  }
}
