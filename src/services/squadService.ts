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
  public static formatMobileNumber(phone: string): string {
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

    // Validate required fields before constructing the payload and calling API
    if (!firstName || !firstName.trim()) {
      throw new Error("Squad provisioning validation failed: first name is missing from verified KYC record");
    }
    if (!lastName || !lastName.trim()) {
      throw new Error("Squad provisioning validation failed: last name is missing from verified KYC record");
    }
    if (!email || !email.trim()) {
      throw new Error("Squad provisioning validation failed: email is missing from verified KYC record");
    }
    if (!bvn || !bvn.trim()) {
      throw new Error("Squad provisioning validation failed: bvn is missing from verified KYC record");
    }
    if (!customer_identifier || !customer_identifier.trim()) {
      throw new Error("Squad provisioning validation failed: customer identifier is missing from verified KYC record");
    }

    const cleanPhone = this.formatMobileNumber(phone || "");
    if (!cleanPhone || cleanPhone.trim() === "") {
      throw new Error("Squad provisioning validation failed: mobile number is missing from verified KYC record");
    }

    // Pre-provider validation for SQUAD_BENEFICIARY_ACCOUNT configuration
    const beneficiaryAccount = env.SQUAD_BENEFICIARY_ACCOUNT ? env.SQUAD_BENEFICIARY_ACCOUNT.trim() : "";
    if (!beneficiaryAccount) {
      throw new Error("Squad provisioning validation failed: SQUAD_BENEFICIARY_ACCOUNT environment variable is missing or empty");
    }
    if (!/^\d{10}$/.test(beneficiaryAccount)) {
      throw new Error("Squad provisioning validation failed: SQUAD_BENEFICIARY_ACCOUNT must be exactly 10 digits");
    }

    logger.info(
      `[SquadService] Requesting virtual account | email=${email} | identifier=${customer_identifier} | reqId=${requestId}`
    );

    const payload = {
      first_name: firstName.trim(),
      last_name: lastName.trim(),
      mobile_num: cleanPhone,
      dob: "01/01/2000", // Standard safe fallback format mm/dd/yyyy
      email: email.trim(),
      bvn: bvn.trim(),
      gender: "1", // Generic fallback: '1' - Male, '2' - Female
      address: "E-Global Head Office, Kano, Nigeria",
      customer_identifier: customer_identifier.trim(),
      beneficiary_account: beneficiaryAccount,
    };

    try {
      const response = await axios.post(
        `${env.SQUAD_BASE_URL}/virtual-account`,
        payload,
        { headers: this.getHeaders(), timeout: 15000 }
      );

      if (response.data && response.data.success && response.data.data) {
        const accData = response.data.data;
        const accountNumberRaw = accData.virtual_account_number || accData.account_number;
        const accountNumber = accountNumberRaw ? String(accountNumberRaw).trim() : "";

        if (!accountNumber) {
          logger.error(`[SquadService] Provisioning error: virtual_account_number is missing in success response | reqId=${requestId}`);
          return {
            success: false,
            bank_name: "",
            account_number: "",
            account_name: "",
            currency: "NGN",
            message: "Squad API success response did not contain a valid virtual account number.",
          };
        }

        logger.info(
          `[SquadService] Account provisioned successfully | accountNumber=${accountNumber} | reqId=${requestId}`
        );
        return {
          success: true,
          bank_name: accData.bank_name || "Guaranty Trust Bank",
          account_number: accountNumber,
          account_name: accData.account_name || accData.customer_name || `${firstName} ${lastName}`,
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
        const conflictAccRaw = resData.data?.virtual_account_number || resData.data?.account_number;
        const conflictAcc = conflictAccRaw ? String(conflictAccRaw).trim() : "";

        if (conflictAcc) {
          return {
            success: true,
            bank_name: resData.data.bank_name || "Guaranty Trust Bank",
            account_number: conflictAcc,
            account_name: resData.data.account_name || resData.data.customer_name || `${firstName} ${lastName}`,
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
