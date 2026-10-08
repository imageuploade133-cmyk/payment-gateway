import { getFlutterwaveClient } from "../providers/flutterwave";
import logger from "../config/logger";
import { extractSenderInfo } from "../utils/senderExtractor";

export interface CreateVirtualAccountParams {
  email: string;
  is_permanent: boolean;
  bvn: string;
  nin?: string;
  tx_ref: string;
  phonenumber: string;
  firstname: string;
  lastname: string;
  requestId: string;
  idempotencyKey?: string;
}

export interface VirtualAccountDetails {
  success: boolean;
  bank_name: string;
  account_number: string;
  account_name: string;
  currency: string;
  reference: string;
  flwRef?: string;
  order_ref?: string;
  message?: string;
}

export interface VerifyPaymentParams {
  transaction_id: string;
  requestId: string;
}

export interface VerificationResult {
  success: boolean;
  status: "successful" | "failed" | "pending";
  isTransient?: boolean;
  isNotFound?: boolean;
  amount: number;
  currency: string;
  reference: string;
  flw_id: string;
  customer: {
    name: string;
    email: string;
    phone?: string;
  };
  sender_name?: string;
  sender_bank?: string;
  sender_account?: string;
  account_number?: string;
  bank_name?: string;
  created_at?: string;
  payment_type?: string;
  message?: string;
  rawTxData?: any;
}

export function isProviderNotFoundResponse(error: any): boolean {
  if (!error) return false;

  const status = error.status || error.statusCode || error.response?.status || error.response?.statusCode;
  const msg = (
    error.message ||
    error.response?.data?.message ||
    error.response?.data?.error ||
    error.data?.message ||
    ""
  ).toString().toLowerCase();

  const is400 = Number(status) === 400;
  const hasNotFoundMessage =
    msg.includes("no transaction was found") ||
    msg.includes("no transaction found") ||
    msg.includes("transaction not found") ||
    msg.includes("transaction was found for this id") ||
    msg.includes("no transaction was found for this reference");

  return is400 && hasNotFoundMessage;
}

export class PaymentVerificationService {
  /**
   * Provision a virtual account (permanent or dynamic) using Flutterwave.
   */
  public static async createVirtualAccount(params: CreateVirtualAccountParams): Promise<VirtualAccountDetails> {
    const { email, is_permanent, bvn, nin, tx_ref, phonenumber, firstname, lastname, requestId, idempotencyKey } = params;

    logger.info(
      `[PaymentVerificationService] Creating virtual account | tx_ref=${tx_ref} | email=${email} | idempotencyKey=${idempotencyKey} | reqId=${requestId}`
    );

    try {
      const client = getFlutterwaveClient();

      const headers = idempotencyKey ? { "X-Idempotency-Key": idempotencyKey } : undefined;

      const response = await client.request("post", "/virtual-account-numbers", {
        email,
        is_permanent,
        bvn,
        ...(nin ? { nin } : {}),
        tx_ref,
        phonenumber,
        firstname,
        lastname,
      }, headers);

      if (response && response.status === "success" && response.data) {
        logger.info(
          `[PaymentVerificationService] Virtual account created successfully | account_number=${response.data.account_number} | reqId=${requestId}`
        );

        return {
          success: true,
          bank_name: response.data.bank_name || "Wema Bank",
          account_number: response.data.account_number,
          account_name: response.data.account_name || `${firstname} ${lastname}`,
          currency: response.data.currency || "NGN",
          reference: tx_ref,
          flwRef: response.data.flw_ref || "",
          order_ref: response.data.order_ref || "",
        };
      }

      logger.error(
        `[PaymentVerificationService] Unexpected response structure from provider during account creation | reqId=${requestId}`
      );
      return {
        success: false,
        bank_name: "",
        account_number: "",
        account_name: "",
        currency: "",
        reference: tx_ref,
        message: "Failed to create virtual account details.",
      };

    } catch (error: any) {
      const errorMsg = error.message || "Unknown error";
      logger.error(
        `[PaymentVerificationService] Provider account creation failed | error=${errorMsg} | reqId=${requestId}`
      );
      return {
        success: false,
        bank_name: "",
        account_number: "",
        account_name: "",
        currency: "",
        reference: tx_ref,
        message: "Unable to provision virtual account details with provider.",
      };
    }
  }

  /**
   * Query virtual account details by its transaction reference (tx_ref) from Flutterwave.
   * This is extremely important to verify if a virtual account already exists prior to retrying provisioning.
   */
  public static async getVirtualAccountByRef(tx_ref: string, requestId: string): Promise<any> {
    logger.info(
      `[PaymentVerificationService] Querying virtual account by reference | tx_ref=${tx_ref} | reqId=${requestId}`
    );

    try {
      const client = getFlutterwaveClient();
      const response = await client.request("get", `/virtual-account-numbers/${tx_ref}`);

      if (response && response.status === "success" && response.data) {
        logger.info(
          `[PaymentVerificationService] Existing virtual account resolved successfully for tx_ref=${tx_ref}`
        );
        return {
          success: true,
          bank_name: response.data.bank_name || "Wema Bank",
          account_number: response.data.account_number,
          account_name: response.data.account_name,
          currency: response.data.currency || "NGN",
          flwRef: response.data.flw_ref || "",
          order_ref: response.data.order_ref || "",
        };
      }
      return { success: false, message: "No virtual account found with this reference." };
    } catch (error: any) {
      logger.warn(
        `[PaymentVerificationService] getVirtualAccountByRef returned error: ${error.message}. Resolving as not found.`
      );
      return { success: false, error: error.message };
    }
  }


  public static async setVirtualAccountStatus(orderRef: string, status: "active" | "inactive", requestId: string): Promise<{success:boolean; message?:string}> {
    if (!orderRef) return { success: false, message: "Virtual account order reference is required." };
    try {
      const client = getFlutterwaveClient();
      const response = await client.request("post", `/virtual-account-numbers/${encodeURIComponent(orderRef)}`, { status });
      if (response?.status === "success") return { success: true, message: response.message };
      return { success: false, message: response?.message || `Provider rejected virtual account status update.` };
    } catch (error: any) {
      logger.error(`[PaymentVerificationService] Virtual account status update failed | reqId=${requestId} | error=${error.message}`);
      return { success: false, message: "Unable to update virtual account status with provider." };
    }
  }

  /**
   * Directly verifies a transaction ID with Flutterwave's V3 API.
   */
  public static async verifyTransaction(params: VerifyPaymentParams): Promise<VerificationResult> {
    const { transaction_id, requestId } = params;

    logger.info(
      `[PaymentVerificationService] Verifying transaction | flw_id=${transaction_id} | reqId=${requestId}`
    );

    try {
      const client = getFlutterwaveClient();

      const response = await client.request("get", `/transactions/${transaction_id}/verify`);

      if (response && response.status === "success" && response.data) {
        const txData = response.data;
        const flwStatus = txData.status?.toLowerCase();

        logger.info(
          `[PaymentVerificationService] Transaction status checked | flw_id=${transaction_id} | status=${flwStatus} | reqId=${requestId}`
        );

        const extracted = extractSenderInfo(txData);

        return {
          success: flwStatus === "successful",
          status: flwStatus === "successful" ? "successful" : flwStatus === "failed" ? "failed" : "pending",
          amount: Number(txData.amount) || 0,
          currency: txData.currency || "NGN",
          reference: txData.tx_ref,
          flw_id: txData.id?.toString(),
          customer: {
            name: txData.customer?.name || "Customer",
            email: txData.customer?.email || "customer@e-tech-hub.com",
            phone: txData.customer?.phone_number || undefined,
          },
          sender_name: extracted.senderName || undefined,
          sender_bank: extracted.senderBankName || undefined,
          sender_account: extracted.senderAccountNumber || undefined,
          account_number: txData.account_number || txData.virtual_account_number || undefined,
          bank_name: txData.bank_name || txData.virtual_account_bank || undefined,
          created_at: txData.created_at || undefined,
          payment_type: txData.payment_type || undefined,
          rawTxData: txData,
        };
      }

      logger.error(
        `[PaymentVerificationService] Unexpected verification payload structure | flw_id=${transaction_id} | reqId=${requestId}`
      );
      return {
        success: false,
        status: "pending",
        isTransient: true,
        amount: 0,
        currency: "NGN",
        reference: "",
        flw_id: transaction_id,
        customer: { name: "", email: "" },
        message: "The payment verification payload returned unexpected or transient results.",
      };

    } catch (error: any) {
      const errorMsg = error.message || "Unknown verification failure";
      logger.error(
        `[PaymentVerificationService] Verification failed on provider side | flw_id=${transaction_id} | error=${errorMsg} | reqId=${requestId}`
      );

      const isNotFound = isProviderNotFoundResponse(error);

      if (isNotFound) {
        return {
          success: false,
          status: "failed",
          isTransient: false,
          isNotFound: true,
          amount: 0,
          currency: "NGN",
          reference: "",
          flw_id: transaction_id,
          customer: { name: "", email: "" },
          message: errorMsg || "No transaction was found for this id",
        };
      }

      return {
        success: false,
        status: "pending",
        isTransient: true,
        isNotFound: false,
        amount: 0,
        currency: "NGN",
        reference: "",
        flw_id: transaction_id,
        customer: { name: "", email: "" },
        message: `Temporary verification error: ${errorMsg}`,
      };
    }
  }

  /**
   * Directly verifies a transaction reference (tx_ref) with Flutterwave's V3 API.
   */
  public static async verifyTransactionByReference(params: { tx_ref: string; requestId: string }): Promise<VerificationResult> {
    const { tx_ref, requestId } = params;

    logger.info(
      `[PaymentVerificationService] Verifying transaction by reference | tx_ref=${tx_ref} | reqId=${requestId}`
    );

    try {
      const client = getFlutterwaveClient();

      let response: any;
      try {
        response = await client.request("get", `/transactions/verify_by_reference?tx_ref=${tx_ref}`);
      } catch (err: any) {
        logger.warn(
          `[PaymentVerificationService] verify_by_reference failed with error: ${err.message}. Trying fallback general transactions list query...`
        );
        // Fallback: Query all transactions filtering by tx_ref
        const queryRes = await client.request("get", `/transactions?tx_ref=${tx_ref}`);
        if (queryRes && queryRes.status === "success" && Array.isArray(queryRes.data) && queryRes.data.length > 0) {
          response = {
            status: "success",
            data: queryRes.data[0]
          };
          logger.info(`[PaymentVerificationService] Fallback general transactions query succeeded for tx_ref=${tx_ref}`);
        } else {
          throw err; // rethrow original error if fallback also yields no results
        }
      }

      if (response && response.status === "success" && response.data) {
        const txData = response.data;
        const flwStatus = txData.status?.toLowerCase();

        logger.info(
          `[PaymentVerificationService] Transaction reference checked | tx_ref=${tx_ref} | status=${flwStatus} | reqId=${requestId}`
        );

        const extracted = extractSenderInfo(txData);

        return {
          success: flwStatus === "successful",
          status: flwStatus === "successful" ? "successful" : flwStatus === "failed" ? "failed" : "pending",
          amount: Number(txData.amount) || 0,
          currency: txData.currency || "NGN",
          reference: txData.tx_ref,
          flw_id: txData.id?.toString(),
          customer: {
            name: txData.customer?.name || "Customer",
            email: txData.customer?.email || "customer@e-tech-hub.com",
            phone: txData.customer?.phone_number || undefined,
          },
          sender_name: extracted.senderName || undefined,
          sender_bank: extracted.senderBankName || undefined,
          sender_account: extracted.senderAccountNumber || undefined,
          account_number: txData.account_number || txData.virtual_account_number || undefined,
          bank_name: txData.bank_name || txData.virtual_account_bank || undefined,
          created_at: txData.created_at || undefined,
          payment_type: txData.payment_type || undefined,
          rawTxData: txData,
        };
      }

      logger.error(
        `[PaymentVerificationService] Unexpected verification payload structure | tx_ref=${tx_ref} | reqId=${requestId}`
      );
      return {
        success: false,
        status: "pending",
        isTransient: true,
        amount: 0,
        currency: "NGN",
        reference: tx_ref,
        flw_id: "",
        customer: { name: "", email: "" },
        message: "The payment verification payload returned unexpected or transient results.",
      };

    } catch (error: any) {
      const errorMsg = error.message || "Unknown verification failure";
      logger.error(
        `[PaymentVerificationService] Reference verification failed on provider side | tx_ref=${tx_ref} | error=${errorMsg} | reqId=${requestId}`
      );

      const isNotFound = isProviderNotFoundResponse(error);

      if (isNotFound) {
        return {
          success: false,
          status: "failed",
          isTransient: false,
          isNotFound: true,
          amount: 0,
          currency: "NGN",
          reference: tx_ref,
          flw_id: "",
          customer: { name: "", email: "" },
          message: errorMsg || "No transaction was found for this reference",
        };
      }

      return {
        success: false,
        status: "pending",
        isTransient: true,
        isNotFound: false,
        amount: 0,
        currency: "NGN",
        reference: tx_ref,
        flw_id: "",
        customer: { name: "", email: "" },
        message: `Temporary verification error: ${errorMsg}`,
      };
    }
  }
}
