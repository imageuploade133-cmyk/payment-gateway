import { getFlutterwaveClient } from "../providers/flutterwave";
import logger from "../config/logger";

export interface CreateVirtualAccountParams {
  email: string;
  is_permanent: boolean;
  bvn: string;
  tx_ref: string;
  phonenumber: string;
  firstname: string;
  lastname: string;
  requestId: string;
}

export interface VirtualAccountDetails {
  success: boolean;
  bank_name: string;
  account_number: string;
  account_name: string;
  currency: string;
  reference: string;
  message?: string;
}

export interface VerifyPaymentParams {
  transaction_id: string;
  requestId: string;
}

export interface VerificationResult {
  success: boolean;
  status: "successful" | "failed" | "pending";
  amount: number;
  currency: string;
  reference: string;
  flw_id: string;
  customer: {
    name: string;
    email: string;
    phone?: string;
  };
  message?: string;
}

export class PaymentVerificationService {
  /**
   * Provision a virtual account (permanent or dynamic) using Flutterwave.
   */
  public static async createVirtualAccount(params: CreateVirtualAccountParams): Promise<VirtualAccountDetails> {
    const { email, is_permanent, bvn, tx_ref, phonenumber, firstname, lastname, requestId } = params;

    logger.info(
      `[PaymentVerificationService] Creating virtual account | tx_ref=${tx_ref} | email=${email} | reqId=${requestId}`
    );

    try {
      const client = getFlutterwaveClient();

      const response = await client.request("post", "/virtual-account-numbers", {
        email,
        is_permanent,
        bvn,
        tx_ref,
        phonenumber,
        firstname,
        lastname,
      });

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
        };
      }

      logger.error(
        `[PaymentVerificationService] Unexpected verification payload structure | flw_id=${transaction_id} | reqId=${requestId}`
      );
      return {
        success: false,
        status: "pending",
        amount: 0,
        currency: "NGN",
        reference: "",
        flw_id: transaction_id,
        customer: { name: "", email: "" },
        message: "The payment verification payload returned unexpected results.",
      };

    } catch (error: any) {
      const errorMsg = error.message || "Unknown verification failure";
      logger.error(
        `[PaymentVerificationService] Verification failed on provider side | flw_id=${transaction_id} | error=${errorMsg} | reqId=${requestId}`
      );
      return {
        success: false,
        status: "failed",
        amount: 0,
        currency: "NGN",
        reference: "",
        flw_id: transaction_id,
        customer: { name: "", email: "" },
        message: "Failed to verify transaction reference with payment provider.",
      };
    }
  }
}
