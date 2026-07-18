import { getFlutterwaveClient } from "../providers/flutterwave";
import logger from "../config/logger";

export interface ResolveAccountParams {
  account_number: string;
  bank_code: string;
  requestId: string;
}

export interface ResolveAccountResponse {
  success: boolean;
  account_name?: string;
  account_number?: string;
  bank_code?: string;
  message?: string;
}

export class AccountResolutionService {
  /**
   * Resolves a bank account number against a specific bank code using Flutterwave.
   */
  public static async resolveBankAccount(params: ResolveAccountParams): Promise<ResolveAccountResponse> {
    const { account_number, bank_code, requestId } = params;

    logger.info(
      `[AccountResolutionService] Initiating account resolution | account_number=${account_number} | bank_code=${bank_code} | reqId=${requestId}`
    );

    try {
      const client = getFlutterwaveClient();

      const response = await client.request("post", "/accounts/resolve", {
        account_number,
        account_bank: bank_code,
      });

      // Verify response structure
      if (response && response.status === "success" && response.data) {
        const accountName = response.data.account_name;
        logger.info(
          `[AccountResolutionService] Account successfully resolved | account_name=${accountName} | reqId=${requestId}`
        );
        return {
          success: true,
          account_name: accountName,
          account_number,
          bank_code,
        };
      }

      logger.error(
        `[AccountResolutionService] Resolution response from provider was negative or empty | reqId=${requestId}`
      );
      return {
        success: false,
        message: "Failed to resolve bank account details.",
      };

    } catch (error: any) {
      // Clean, secure error mapping: Never expose Flutterwave internal secrets, database fields or API codes directly.
      const errorMsg = error.message || "An unexpected error occurred during account resolution.";
      logger.error(
        `[AccountResolutionService] Resolution failed | error=${errorMsg} | reqId=${requestId}`
      );

      return {
        success: false,
        message: "Unable to verify account details. Please check the bank and account number.",
      };
    }
  }
}
