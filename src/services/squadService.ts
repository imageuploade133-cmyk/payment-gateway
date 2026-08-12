import axios from "axios";
import { env } from "../config/env";
import logger from "../config/logger";

export interface SquadVirtualAccountParams {
  email: string;
  firstName: string;
  lastName: string;
  phone: string;
  bvn: string;
  customer_identifier: string;
  requestId: string;
}

export interface SquadVirtualAccountResponse {
  success: boolean;
  bank_name: string;
  account_number: string;
  account_name: string;
  currency: string;
  message?: string;
}

export class SquadService {
  /**
   * Helper to format headers securely using SQUAD_SECRET_KEY
   */
  private static getHeaders(): Record<string, string> {
    const key = env.SQUAD_SECRET_KEY || "sandbox_sk_mock";
    return {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
    };
  }

  /**
   * Cleans phone number format exactly to 11 local digits (e.g. 08012345678)
   */
  private static formatMobileNumber(phone: string): string {
    let clean = phone.trim().replace(/[^0-9]/g, "");
    if (clean.startsWith("234") && clean.length > 10) {
      clean = "0" + clean.substring(3);
    }
    // Pad or trim to exactly 11 digits
    if (clean.length > 11) {
      clean = clean.substring(0, 11);
    } else if (clean.length < 11 && clean.length >= 10 && !clean.startsWith("0")) {
      clean = "0" + clean;
    }
    return clean;
  }

  /**
   * Calls Squadco POST /virtual-account API to provision a customer virtual account
   */
  public static async createVirtualAccount(params: SquadVirtualAccountParams): Promise<SquadVirtualAccountResponse> {
    const { email, firstName, lastName, phone, bvn, customer_identifier, requestId } = params;
    const cleanPhone = this.formatMobileNumber(phone);

    logger.info(
      `[SquadService] Requesting virtual account | email=${email} | identifier=${customer_identifier} | reqId=${requestId}`
    );

    const payload = {
      first_name: firstName,
      last_name: lastName,
      mobile_num: cleanPhone,
      dob: "01/01/2000", // Standard safe fallback format mm/dd/yyyy
      email: email,
      bvn: bvn,
      gender: "1", // Generic fallback: '1' - Male, '2' - Female
      address: "E-Global Head Office, Kano, Nigeria",
      customer_identifier: customer_identifier,
    };

    try {
      const response = await axios.post(
        `${env.SQUAD_BASE_URL}/virtual-account`,
        payload,
        { headers: this.getHeaders(), timeout: 15000 }
      );

      if (response.data && response.data.success && response.data.data) {
        const accData = response.data.data;
        logger.info(
          `[SquadService] Account provisioned successfully | accountNumber=${accData.account_number} | reqId=${requestId}`
        );
        return {
          success: true,
          bank_name: accData.bank_name || "Guaranty Trust Bank",
          account_number: accData.account_number,
          account_name: accData.account_name || `${firstName} ${lastName}`,
          currency: accData.currency || "NGN",
        };
      }

      logger.warn(
        `[SquadService] Unexpected response body structure from Squadco: ${JSON.stringify(response.data)} | reqId=${requestId}`
      );
      return {
        success: false,
        bank_name: "",
        account_number: "",
        account_name: "",
        currency: "NGN",
        message: response.data?.message || "Failed to receive account credentials from Squadco.",
      };

    } catch (err: any) {
      const status = err.response?.status;
      const resData = err.response?.data;
      const errMsg = err.message || "Unknown communication error";

      logger.error(
        `[SquadService] Creation failure | status=${status} | error=${errMsg} | body=${JSON.stringify(resData)} | reqId=${requestId}`
      );

      // Handle duplicate/conflict responses gracefully
      // If the account was already provisioned under this identifier or BVN, Squad might return specific conflict errors.
      if (resData && (resData.message?.toLowerCase().includes("already") || resData.message?.toLowerCase().includes("exists") || resData.message?.toLowerCase().includes("duplicate"))) {
        logger.warn(`[SquadService] Conflict response detected from Squad. Attempting safe recovery. Message: ${resData.message}`);
        
        // If Squad returns the existing account details directly inside the error payload or data block, recover it
        if (resData.data && resData.data.account_number) {
          return {
            success: true,
            bank_name: resData.data.bank_name || "Guaranty Trust Bank",
            account_number: resData.data.account_number,
            account_name: resData.data.account_name || `${firstName} ${lastName}`,
            currency: resData.data.currency || "NGN",
            message: "Recovered successfully from existing Squad registration."
          };
        }

        return {
          success: false,
          bank_name: "",
          account_number: "",
          account_name: "",
          currency: "NGN",
          message: `SQUAD_CONFLICT: ${resData.message || "Account already registered under another ID."}`
        };
      }

      return {
        success: false,
        bank_name: "",
        account_number: "",
        account_name: "",
        currency: "NGN",
        message: resData?.message || `Squad API error: ${errMsg}`,
      };
    }
  }
}
