import axios, { AxiosResponse } from "axios";
import logger from "../config/logger";
import { clubkonnectConfig } from "../config/clubkonnect";

export interface ClubkonnectBalanceResponse {
  success: boolean;
  provider: string;
  balance: number;
}

export class ClubkonnectService {
  /**
   * Fetches the wallet balance from Clubkonnect with timeout, logging, and automatic retries.
   * Calls: GET https://www.nellobytesystems.com/APIWalletBalanceV1.asp?UserID={USER_ID}&APIKey={API_KEY}
   */
  static async getWalletBalance(requestId?: string): Promise<ClubkonnectBalanceResponse> {
    const { BASE_URL, USER_ID, API_KEY } = clubkonnectConfig;

    if (!USER_ID || !API_KEY) {
      throw new Error("Clubkonnect credentials (CLUBKONNECT_USER_ID or CLUBKONNECT_API_KEY) are not configured.");
    }

    const url = `${BASE_URL}/APIWalletBalanceV1.asp?UserID=${USER_ID}&APIKey=${API_KEY}`;
    const timeout = 10000; // 10 seconds timeout
    const maxRetries = 2; // 2 retries (3 total attempts)

    let attempt = 0;
    while (true) {
      let response: AxiosResponse;

      try {
        // Mask the API Key and User ID in logs slightly to protect secrets while providing debugging details
        const maskedKey = API_KEY.length > 5 ? `${API_KEY.slice(0, 3)}***${API_KEY.slice(-2)}` : "***";
        logger.info(
          `[Clubkonnect Service] Initiating wallet balance request | URL=${BASE_URL}/APIWalletBalanceV1.asp?UserID=${USER_ID}&APIKey=${maskedKey} | attempt=${attempt + 1}/${maxRetries + 1} | reqId=${requestId}`
        );

        response = await axios.get(url, {
          timeout,
          headers: {
            "Accept": "application/json",
          },
        });
      } catch (requestError: any) {
        attempt++;
        logger.error(
          `[Clubkonnect Service] Network/HTTP error fetching Clubkonnect balance (attempt ${attempt}/${maxRetries + 1}) | error=${requestError.message} | reqId=${requestId}`
        );

        if (attempt > maxRetries) {
          throw new Error(`Failed to retrieve wallet balance from Clubkonnect after ${attempt} attempts. Original error: ${requestError.message}`);
        }
        continue; // Retry the request
      }

      // Successful HTTP response received. Now perform payload validation. Do not retry if validation fails.
      logger.info(
        `[Clubkonnect Service] Received response from Clubkonnect | status=${response.status} | body=${JSON.stringify(response.data)} | reqId=${requestId}`
      );

      const data = response.data;
      if (!data || typeof data !== "object") {
        throw new Error("Invalid response format received from Clubkonnect API (not a JSON object).");
      }

      const balanceStr = data.balance;
      if (balanceStr === undefined || balanceStr === null) {
        throw new Error("Clubkonnect response does not contain 'balance' field.");
      }

      const balanceNum = parseFloat(balanceStr);
      if (isNaN(balanceNum)) {
        throw new Error(`Clubkonnect balance value '${balanceStr}' is not a valid number.`);
      }

      return {
        success: true,
        provider: "Clubkonnect",
        balance: balanceNum,
      };
    }
  }
}
