import axios, { AxiosResponse } from "axios";
import logger from "../config/logger";
import { clubkonnectConfig, networkCache, DEFAULT_NETWORK_MAPPINGS, dataPlanCache, DEFAULT_DATA_PLANS } from "../config/clubkonnect";

export interface ClubkonnectBalanceResponse {
  success: boolean;
  provider: string;
  balance: number;
}

export interface PurchaseAirtimeParams {
  network: string; // e.g. "MTN", "GLO"
  phone: string;    // e.g. "08012345678"
  amount: number;   // e.g. 100
  requestId: string; // Unique RequestID
  callbackUrl?: string;
}

export interface PurchaseDataParams {
  network: string;  // e.g. "MTN", "GLO"
  phone: string;    // e.g. "08012345678"
  planCode: string; // e.g. "1", "glo-1"
  requestId: string; // Unique RequestID
  callbackUrl?: string;
}

export interface AirtimeResponse {
  success: boolean;
  orderId?: string;
  status: "Pending" | "Failed";
  message?: string;
}

export interface DataResponse {
  success: boolean;
  orderId?: string;
  status: "Pending" | "Failed";
  message?: string;
}

export interface QueryTransactionResponse {
  success: boolean;
  status: string;
  orderId?: string;
  remark?: string;
}

export class ClubkonnectService {
  /**
   * Refreshes the dynamic network code mappings from Clubkonnect API.
   * Calls: GET https://www.nellobytesystems.com/APIAirtimeNetworkV2.asp
   */
  static async refreshNetworkCache(requestId?: string): Promise<void> {
    const { BASE_URL, USER_ID, API_KEY } = clubkonnectConfig;
    if (!USER_ID || !API_KEY) return;

    const url = `${BASE_URL}/APIAirtimeNetworkV2.asp?UserID=${USER_ID}&APIKey=${API_KEY}`;
    logger.info(`[Clubkonnect Service] Refreshing dynamic network cache | reqId=${requestId}`);

    try {
      const response: AxiosResponse = await axios.get(url, { timeout: 10000 });
      logger.info(`[Clubkonnect Service] Dynamic network response | status=${response.status} | body=${JSON.stringify(response.data)} | reqId=${requestId}`);

      const data = response.data;
      if (data && typeof data === "object") {
        const newMappings: Record<string, string> = {};
        for (const [key, val] of Object.entries(data)) {
          if (typeof val === "string" || typeof val === "number") {
            const normalizedKey = key.trim().toUpperCase();
            newMappings[normalizedKey] = String(val).trim();
            // Handle common alias e.g. Etisalat / 9Mobile
            if (normalizedKey === "ETISALAT") {
              newMappings["9MOBILE"] = String(val).trim();
            }
          }
        }

        if (Object.keys(newMappings).length > 0) {
          networkCache.mappings = { ...DEFAULT_NETWORK_MAPPINGS, ...newMappings };
          networkCache.lastFetched = Date.now();
          logger.info(`[Clubkonnect Service] Successfully cached ${Object.keys(newMappings).length} network codes from API.`);
          return;
        }
      }
      throw new Error("Invalid or empty response format received for network codes");
    } catch (error: any) {
      logger.error(`[Clubkonnect Service] Failed to fetch dynamic network codes: ${error.message} | reqId=${requestId}`);
      // Fallback is already initialized in networkCache.mappings, do not overwrite if fetch fails
    }
  }

  /**
   * Resolves a network name to its mapped Clubkonnect numeric code.
   */
  static async getNetworkCode(networkName: string, requestId?: string): Promise<string> {
    const now = Date.now();
    const cacheDuration = 12 * 60 * 60 * 1000; // 12 hours cache
    const normalizedInput = networkName.trim().toUpperCase();

    if (now - networkCache.lastFetched > cacheDuration) {
      await this.refreshNetworkCache(requestId);
    }

    const code = networkCache.mappings[normalizedInput];
    if (!code) {
      throw new Error(`Unsupported network: ${networkName}`);
    }
    return code;
  }

  /**
   * Refreshes dynamic mobile data plan codes from Clubkonnect API.
   * Calls: GET https://www.nellobytesystems.com/APIDatasharePlansV1.asp
   */
  static async refreshDataPlanCache(requestId?: string): Promise<void> {
    const { BASE_URL, USER_ID, API_KEY } = clubkonnectConfig;
    if (!USER_ID || !API_KEY) return;

    const url = `${BASE_URL}/APIDatasharePlansV1.asp?UserID=${USER_ID}&APIKey=${API_KEY}`;
    logger.info(`[Clubkonnect Service] Refreshing dynamic mobile data plans cache | reqId=${requestId}`);

    try {
      const response: AxiosResponse = await axios.get(url, { timeout: 10000 });
      logger.info(`[Clubkonnect Service] Dynamic data plans response | status=${response.status} | reqId=${requestId}`);

      const data = response.data;
      // If we receive valid object data from provider, we can dynamically cache plans
      if (data && typeof data === "object") {
        const plansGrouped: Record<string, any[]> = {
          "MTN": [],
          "GLO": [],
          "AIRTEL": [],
          "9MOBILE": []
        };

        // Example parsing from Clubkonnect data share plan structure
        for (const [key, val] of Object.entries(data)) {
          if (Array.isArray(val)) {
            const normalizedNetwork = key.trim().toUpperCase();
            plansGrouped[normalizedNetwork] = val.map((plan: any) => ({
              item_code: plan.plan_id || plan.id || `${normalizedNetwork.toLowerCase()}_${plan.size || "plan"}`,
              name: plan.name || `${normalizedNetwork} ${plan.size || "Data Plan"}`,
              amount: Number(plan.amount || plan.price) || 0,
              plan_code: plan.plan_code || plan.id || "",
            }));
          }
        }

        // Only overwrite cache if we successfully retrieved some records
        const planCount = Object.values(plansGrouped).reduce((acc, curr) => acc + curr.length, 0);
        if (planCount > 0) {
          dataPlanCache.plans = plansGrouped;
          dataPlanCache.lastFetched = Date.now();
          logger.info(`[Clubkonnect Service] Successfully cached ${planCount} data plans from API.`);
          return;
        }
      }
      throw new Error("Invalid or empty response format received for data plans.");
    } catch (error: any) {
      logger.error(`[Clubkonnect Service] Failed to fetch dynamic data plans: ${error.message} | reqId=${requestId}`);
      // Fallback is already initialized in dataPlanCache.plans, do not overwrite if fetch fails
    }
  }

  /**
   * Resolves and fetches the available data plans.
   */
  static async getDataPlans(networkName?: string, requestId?: string): Promise<any[]> {
    const now = Date.now();
    const cacheDuration = 12 * 60 * 60 * 1000; // 12 hours cache

    if (now - dataPlanCache.lastFetched > cacheDuration) {
      await this.refreshDataPlanCache(requestId);
    }

    if (networkName) {
      const normalizedNetwork = networkName.trim().toUpperCase();
      return dataPlanCache.plans[normalizedNetwork] || [];
    }

    return Object.values(dataPlanCache.plans).flat();
  }

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

  /**
   * Executes an airtime purchase request on Clubkonnect API.
   * Calls: GET https://www.nellobytesystems.com/APIAirtimeV1.asp
   */
  static async purchaseAirtime(params: PurchaseAirtimeParams, requestId?: string): Promise<AirtimeResponse> {
    const { BASE_URL, USER_ID, API_KEY } = clubkonnectConfig;

    if (!USER_ID || !API_KEY) {
      throw new Error("Clubkonnect credentials (CLUBKONNECT_USER_ID or CLUBKONNECT_API_KEY) are not configured.");
    }

    const networkCode = await this.getNetworkCode(params.network, requestId);
    const cbParam = params.callbackUrl ? `&CallBackURL=${encodeURIComponent(params.callbackUrl)}` : "";
    const url = `${BASE_URL}/APIAirtimeV1.asp?UserID=${USER_ID}&APIKey=${API_KEY}&MobileNetwork=${networkCode}&Amount=${params.amount}&MobileNumber=${params.phone}&RequestID=${params.requestId}${cbParam}`;

    const timeout = 10000; // 10 seconds
    const maxRetries = 2; // 2 retries (3 attempts total)

    let attempt = 0;
    while (true) {
      let response: AxiosResponse;

      try {
        const maskedKey = API_KEY.length > 5 ? `${API_KEY.slice(0, 3)}***${API_KEY.slice(-2)}` : "***";
        logger.info(
          `[Clubkonnect Service] Sending airtime purchase request | URL=${BASE_URL}/APIAirtimeV1.asp?UserID=${USER_ID}&APIKey=${maskedKey}&MobileNetwork=${networkCode}&Amount=${params.amount}&MobileNumber=${params.phone}&RequestID=${params.requestId} | attempt=${attempt + 1}/${maxRetries + 1} | reqId=${requestId}`
        );

        response = await axios.get(url, { timeout });
      } catch (requestError: any) {
        attempt++;
        logger.error(
          `[Clubkonnect Service] Network/HTTP error executing airtime purchase (attempt ${attempt}/${maxRetries + 1}) | error=${requestError.message} | reqId=${requestId}`
        );

        if (attempt > maxRetries) {
          throw new Error(`Failed to complete airtime purchase from Clubkonnect after ${attempt} attempts. Original error: ${requestError.message}`);
        }
        continue;
      }

      logger.info(
        `[Clubkonnect Service] Airtime purchase response received | status=${response.status} | body=${JSON.stringify(response.data)} | reqId=${requestId}`
      );

      const data = response.data;
      if (!data || typeof data !== "object") {
        throw new Error("Invalid response format received from Clubkonnect API during airtime purchase.");
      }

      const status = String(data.status || "").trim().toUpperCase();
      if (status === "ORDER_RECEIVED") {
        return {
          success: true,
          orderId: data.orderid ? String(data.orderid) : undefined,
          status: "Pending",
          message: data.remark || "Airtime order accepted successfully.",
        };
      }

      return {
        success: false,
        status: "Failed",
        message: data.remark || data.remark_desc || `Clubkonnect rejected request with status: ${data.status}`,
      };
    }
  }

  /**
   * Executes a mobile data plan purchase on Clubkonnect API.
   * Calls: GET https://www.nellobytesystems.com/APIDataV1.asp
   */
  static async purchaseData(params: PurchaseDataParams, requestId?: string): Promise<DataResponse> {
    const { BASE_URL, USER_ID, API_KEY } = clubkonnectConfig;

    if (!USER_ID || !API_KEY) {
      throw new Error("Clubkonnect credentials (CLUBKONNECT_USER_ID or CLUBKONNECT_API_KEY) are not configured.");
    }

    const networkCode = await this.getNetworkCode(params.network, requestId);
    const cbParam = params.callbackUrl ? `&CallBackURL=${encodeURIComponent(params.callbackUrl)}` : "";
    const url = `${BASE_URL}/APIDataV1.asp?UserID=${USER_ID}&APIKey=${API_KEY}&MobileNetwork=${networkCode}&DataPlan=${params.planCode}&MobileNumber=${params.phone}&RequestID=${params.requestId}${cbParam}`;

    const timeout = 10000; // 10 seconds
    const maxRetries = 2; // 2 retries (3 attempts total)

    let attempt = 0;
    while (true) {
      let response: AxiosResponse;

      try {
        const maskedKey = API_KEY.length > 5 ? `${API_KEY.slice(0, 3)}***${API_KEY.slice(-2)}` : "***";
        logger.info(
          `[Clubkonnect Service] Sending mobile data purchase request | URL=${BASE_URL}/APIDataV1.asp?UserID=${USER_ID}&APIKey=${maskedKey}&MobileNetwork=${networkCode}&DataPlan=${params.planCode}&MobileNumber=${params.phone}&RequestID=${params.requestId} | attempt=${attempt + 1}/${maxRetries + 1} | reqId=${requestId}`
        );

        response = await axios.get(url, { timeout });
      } catch (requestError: any) {
        attempt++;
        logger.error(
          `[Clubkonnect Service] Network/HTTP error executing mobile data purchase (attempt ${attempt}/${maxRetries + 1}) | error=${requestError.message} | reqId=${requestId}`
        );

        if (attempt > maxRetries) {
          throw new Error(`Failed to complete mobile data purchase from Clubkonnect after ${attempt} attempts. Original error: ${requestError.message}`);
        }
        continue;
      }

      logger.info(
        `[Clubkonnect Service] Mobile data purchase response received | status=${response.status} | body=${JSON.stringify(response.data)} | reqId=${requestId}`
      );

      const data = response.data;
      if (!data || typeof data !== "object") {
        throw new Error("Invalid response format received from Clubkonnect API during data purchase.");
      }

      const status = String(data.status || "").trim().toUpperCase();
      if (status === "ORDER_RECEIVED") {
        return {
          success: true,
          orderId: data.orderid ? String(data.orderid) : undefined,
          status: "Pending",
          message: data.remark || "Data order accepted successfully.",
        };
      }

      return {
        success: false,
        status: "Failed",
        message: data.remark || data.remark_desc || `Clubkonnect rejected request with status: ${data.status}`,
      };
    }
  }

  /**
   * Queries a transaction status on Clubkonnect API.
   * Calls: GET https://www.nellobytesystems.com/APIQueryV1.asp
   */
  static async queryAirtimeTransaction(params: { orderId?: string; requestId?: string }, requestId?: string): Promise<QueryTransactionResponse> {
    const { BASE_URL, USER_ID, API_KEY } = clubkonnectConfig;

    if (!USER_ID || !API_KEY) {
      throw new Error("Clubkonnect credentials (CLUBKONNECT_USER_ID or CLUBKONNECT_API_KEY) are not configured.");
    }

    let queryParam = "";
    if (params.orderId) {
      queryParam = `&OrderID=${params.orderId}`;
    } else if (params.requestId) {
      queryParam = `&RequestID=${params.requestId}`;
    } else {
      throw new Error("Either OrderID or RequestID must be provided to query transaction.");
    }

    const url = `${BASE_URL}/APIQueryV1.asp?UserID=${USER_ID}&APIKey=${API_KEY}${queryParam}`;
    const timeout = 10000;

    try {
      const maskedKey = API_KEY.length > 5 ? `${API_KEY.slice(0, 3)}***${API_KEY.slice(-2)}` : "***";
      logger.info(
        `[Clubkonnect Service] Sending transaction query | URL=${BASE_URL}/APIQueryV1.asp?UserID=${USER_ID}&APIKey=${maskedKey}${queryParam} | reqId=${requestId}`
      );

      const response: AxiosResponse = await axios.get(url, { timeout });
      logger.info(
        `[Clubkonnect Service] Transaction query response received | status=${response.status} | body=${JSON.stringify(response.data)} | reqId=${requestId}`
      );

      const data = response.data;
      if (!data || typeof data !== "object") {
        throw new Error("Invalid response format received from Clubkonnect API during transaction query.");
      }

      return {
        success: true,
        status: data.status ? String(data.status) : "UNKNOWN",
        orderId: data.orderid ? String(data.orderid) : undefined,
        remark: data.remark || data.remark_desc || undefined,
      };
    } catch (error: any) {
      logger.error(`[Clubkonnect Service] Failed to query transaction from Clubkonnect: ${error.message} | reqId=${requestId}`);
      throw error;
    }
  }
}
