import axios, { AxiosResponse } from "axios";
import logger from "../config/logger";
import { clubkonnectConfig, networkCache, DEFAULT_NETWORK_MAPPINGS, dataPlanCache, DEFAULT_DATA_PLANS } from "../config/clubkonnect";
import { adminDb } from "../config/firebase";

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

export function sanitizeUrlAndPayload(inputStr: string): string {
  if (!inputStr || typeof inputStr !== "string") return "";
  return inputStr.replace(/APIKey=([^&"'<>\s]+)/gi, (_match, keyVal) => {
    if (!keyVal || keyVal.length <= 5) return "APIKey=***";
    return `APIKey=${keyVal.slice(0, 3)}***${keyVal.slice(-2)}`;
  });
}

export function extractSanitizedAxiosError(err: any) {
  const status = err?.response?.status || "NO_STATUS";
  let body = "NO_BODY";
  if (err?.response?.data !== undefined && err?.response?.data !== null) {
    if (typeof err.response.data === "object") {
      body = sanitizeUrlAndPayload(JSON.stringify(err.response.data));
    } else {
      body = sanitizeUrlAndPayload(String(err.response.data));
    }
  }

  let headers = "NO_HEADERS";
  if (err?.response?.headers && typeof err.response.headers === "object") {
    const h = err.response.headers;
    headers = JSON.stringify({
      "content-type": h["content-type"] || h["Content-Type"],
      "server": h["server"] || h["Server"],
      "cf-ray": h["cf-ray"] || h["Cf-Ray"],
      "date": h["date"] || h["Date"],
    });
  }

  const code = err?.code || "ERR_AXIOS";
  const message = sanitizeUrlAndPayload(err?.message || "Axios HTTP request failed");

  return { status, body, headers, code, message };
}

const DEFAULT_CLUBKONNECT_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept": "application/json, text/html, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Connection": "keep-alive",
};

export class ClubkonnectService {
  /**
   * Refreshes the dynamic network code mappings from Clubkonnect API.
   * Calls: GET https://www.nellobytesystems.com/APIAirtimeNetworkV2.asp
   */
  static async refreshNetworkCache(requestId?: string): Promise<void> {
    const { BASE_URL, USER_ID, API_KEY } = clubkonnectConfig;
    if (!USER_ID || !API_KEY) return;

    const url = `${BASE_URL}/APIAirtimeNetworkV2.asp?UserID=${encodeURIComponent(USER_ID)}&APIKey=${encodeURIComponent(API_KEY)}`;
    logger.info(`[Clubkonnect Service] Refreshing dynamic network cache | reqId=${requestId}`);

    try {
      const response: AxiosResponse = await axios.get(url, {
        timeout: 10000,
        headers: DEFAULT_CLUBKONNECT_HEADERS,
      });
      if (!response) {
        throw new Error("Empty response received from Clubkonnect API");
      }
      logger.info(`[Clubkonnect Service] Dynamic network response | status=${response.status} | body=${JSON.stringify(response.data)} | reqId=${requestId}`);

      let data = response.data;
      if (typeof data === "string") {
        try {
          data = JSON.parse(data.trim());
        } catch (parseErr: any) {
          logger.error(`[Clubkonnect Service] Failed to parse network raw string as JSON: ${parseErr.message}`);
        }
      }

      if (data && typeof data === "object") {
        const newMappings: Record<string, string> = {};
        const networksList = Array.isArray(data.MOBILE_NETWORK) ? data.MOBILE_NETWORK : [];
        for (const item of networksList) {
          if (item && item.NETWORK_NAME && item.NETWORK_ID) {
            const name = String(item.NETWORK_NAME).trim().toUpperCase();
            const id = String(item.NETWORK_ID).trim();
            newMappings[name] = id;
            if (name === "GLO") {
              newMappings["GLO"] = id;
            }
            if (name === "T2MOBILE" || name === "ETISALAT" || name === "9ONLINE" || name === "9MOBILE") {
              newMappings["T2MOBILE"] = id;
              newMappings["9MOBILE"] = id;
              newMappings["ETISALAT"] = id;
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
    }
  }

  /**
   * Resolves a network name to its mapped Clubkonnect numeric code.
   */
  static async getNetworkCode(networkName: string, requestId?: string): Promise<string> {
    const now = Date.now();
    const cacheDuration = 12 * 60 * 60 * 1000;
    const normalizedInput = networkName.trim().toUpperCase();

    if (now - networkCache.lastFetched > cacheDuration) {
      await this.refreshNetworkCache(requestId);
    }

    const code = networkCache.mappings[normalizedInput];
    if (!code) {
      if (normalizedInput.includes("MTN") || normalizedInput === "01") return "01";
      if (normalizedInput.includes("GLO") || normalizedInput === "02") return "02";
      if (normalizedInput.includes("9MOBILE") || normalizedInput.includes("ETISALAT") || normalizedInput === "03") return "03";
      if (normalizedInput.includes("AIRTEL") || normalizedInput === "04") return "04";
      throw new Error(`Unsupported network: ${networkName}`);
    }
    return code;
  }

  /**
   * Refreshes dynamic mobile data plan codes from Clubkonnect API.
   * Calls: GET https://www.nellobytesystems.com/APIDatabundlePlansV2.asp
   */
  static async refreshDataPlanCache(requestId?: string): Promise<void> {
    const { BASE_URL, USER_ID, API_KEY } = clubkonnectConfig;
    if (!USER_ID || !API_KEY) return;

    const url = `${BASE_URL}/APIDatabundlePlansV2.asp?UserID=${encodeURIComponent(USER_ID)}&APIKey=${encodeURIComponent(API_KEY)}`;
    logger.info(`[Clubkonnect Service] Refreshing dynamic mobile data plans cache via APIDatabundlePlansV2.asp | reqId=${requestId}`);

    try {
      const response: AxiosResponse = await axios.get(url, {
        timeout: 10000,
        headers: DEFAULT_CLUBKONNECT_HEADERS,
      });
      if (!response) {
        throw new Error("Empty response received from Clubkonnect API");
      }

      let data = response.data;
      if (typeof data === "string") {
        try {
          data = JSON.parse(data.trim());
        } catch (parseErr: any) {
          logger.error(`[Clubkonnect Service] Failed to parse data plans raw string as JSON: ${parseErr.message}`);
        }
      }

      if (data && typeof data === "object") {
        const plansGrouped: Record<string, any[]> = {
          "MTN": [],
          "GLO": [],
          "AIRTEL": [],
          "9MOBILE": []
        };

        let payload = data;
        const possibleWrappers = ["MOBILE_NETWORK", "MOBILE_DATABUNDLE", "DATABUNDLE", "DATA", "MOBILE_DATA"];
        for (const wrapper of possibleWrappers) {
          if (data[wrapper] && typeof data[wrapper] === "object") {
            payload = data[wrapper];
            break;
          }
        }

        if (Array.isArray(payload)) {
          for (const item of payload) {
            if (!item || typeof item !== "object") continue;

            let list: any[] = [];
            if (Array.isArray(item.PRODUCT)) list = item.PRODUCT;
            else if (Array.isArray(item.product)) list = item.product;
            else if (Array.isArray(item.products)) list = item.products;
            else list = [item];

            for (const sub of list) {
              const rawNet = sub.NETWORK_NAME || sub.NETWORK || sub.network || sub.MobileNetwork || item.NETWORK_NAME || item.NETWORK || item.network || "";
              const normNet = String(rawNet).trim().toUpperCase();
              let targetNet = "";
              if (normNet.includes("MTN")) targetNet = "MTN";
              else if (normNet.includes("GLO")) targetNet = "GLO";
              else if (normNet.includes("AIRTEL")) targetNet = "AIRTEL";
              else if (normNet.includes("9MOBILE") || normNet.includes("9MOB") || normNet.includes("ETISALAT") || normNet.includes("T2MOBILE") || normNet.includes("M_9MOBILE")) targetNet = "9MOBILE";

              if (targetNet) {
                const id = sub.PRODUCT_ID || sub.productId || sub.product_id || sub.plan_id || sub.id || sub.ID || "";
                const name = sub.PRODUCT_NAME || sub.productName || sub.product_name || sub.name || sub.NAME || sub.plan_name || sub.PLAN_NAME || sub.DESCRIPTION || "";
                const amount = Number(sub.PRODUCT_AMOUNT || sub.productAmount || sub.product_amount || sub.amount || sub.AMOUNT || sub.PRICE || sub.price || sub.PLAN_AMOUNT || sub.plan_amount || 0);
                const plan_code = sub.PRODUCT_CODE || sub.productCode || sub.product_code || sub.plan_code || sub.PLAN_CODE || id || "";

                if (id && name && amount > 0) {
                  plansGrouped[targetNet].push({
                    item_code: `${targetNet.toLowerCase()}_${String(id).trim()}`,
                    name: String(name).trim(),
                    amount,
                    plan_code: String(plan_code).trim(),
                  });
                }
              }
            }
          }
        } else {
          for (const [key, val] of Object.entries(payload)) {
            const normNet = key.trim().toUpperCase();
            let targetNet = "";
            if (normNet.includes("MTN") || normNet === "01") targetNet = "MTN";
            else if (normNet.includes("GLO") || normNet === "02") targetNet = "GLO";
            else if (normNet.includes("AIRTEL") || normNet === "04") targetNet = "AIRTEL";
            else if (normNet.includes("9MOBILE") || normNet.includes("9MOB") || normNet.includes("ETISALAT") || normNet.includes("T2MOBILE") || normNet.includes("M_9MOBILE") || normNet === "03") targetNet = "9MOBILE";

            if (targetNet) {
              const itemsList = Array.isArray(val) ? val : [val];
              for (const item of itemsList) {
                if (!item || typeof item !== "object") continue;

                let productsArray: any[] = [];
                if (Array.isArray(item.PRODUCT)) {
                  productsArray = item.PRODUCT;
                } else if (Array.isArray(item.product)) {
                  productsArray = item.product;
                } else if (Array.isArray(item.products)) {
                  productsArray = item.products;
                } else if (item.PRODUCT && typeof item.PRODUCT === "object") {
                  productsArray = Array.isArray(item.PRODUCT) ? item.PRODUCT : [item.PRODUCT];
                } else {
                  productsArray = [item];
                }

                for (const sub of productsArray) {
                  if (!sub || typeof sub !== "object") continue;

                  const id = sub.PRODUCT_ID || sub.productId || sub.product_id || sub.plan_id || sub.id || sub.ID || "";
                  const name = sub.PRODUCT_NAME || sub.productName || sub.product_name || sub.name || sub.NAME || sub.plan_name || sub.PLAN_NAME || sub.DESCRIPTION || "";
                  const amount = Number(sub.PRODUCT_AMOUNT || sub.productAmount || sub.product_amount || sub.amount || sub.AMOUNT || sub.PRICE || sub.price || sub.PLAN_AMOUNT || sub.plan_amount || 0);
                  const plan_code = sub.PRODUCT_CODE || sub.productCode || sub.product_code || sub.plan_code || sub.PLAN_CODE || id || "";

                  if (id && name && amount > 0) {
                    plansGrouped[targetNet].push({
                      item_code: `${targetNet.toLowerCase()}_${String(id).trim()}`,
                      name: String(name).trim(),
                      amount,
                      plan_code: String(plan_code).trim(),
                    });
                  }
                }
              }
            }
          }
        }

        const planCount = Object.values(plansGrouped).reduce((acc, curr) => acc + curr.length, 0);
        if (planCount > 0) {
          dataPlanCache.plans = plansGrouped;
          dataPlanCache.lastFetched = Date.now();

          if (adminDb) {
            try {
              await adminDb.collection("config").doc("vtu_data_plans_cache").set({
                plans: plansGrouped,
                lastFetched: Date.now()
              }, { merge: true });
            } catch (dbErr: any) {
              logger.error(`[Clubkonnect Service] Failed to update Firestore plans cache: ${dbErr.message}`);
            }
          }
          return;
        }
      }
      throw new Error("Invalid or empty response format received for data plans.");
    } catch (error: any) {
      logger.error(`[Clubkonnect Service] Failed to fetch dynamic data plans: ${error.message} | reqId=${requestId}`);
    }
  }

  static async getDataPlans(networkName?: string, requestId?: string): Promise<any[]> {
    const now = Date.now();
    const cacheDuration = 12 * 60 * 60 * 1000;

    if (now - dataPlanCache.lastFetched > cacheDuration) {
      await this.refreshDataPlanCache(requestId);
    }

    const hasPlans = Object.values(dataPlanCache.plans).some(arr => arr.length > 0);
    if (!hasPlans && adminDb) {
      try {
        const docSnap = await adminDb.collection("config").doc("vtu_data_plans_cache").get();
        if (docSnap.exists) {
          const docData = docSnap.data();
          if (docData && docData.plans) {
            dataPlanCache.plans = docData.plans;
            dataPlanCache.lastFetched = docData.lastFetched || Date.now();
          }
        }
      } catch (dbErr: any) {
        logger.error(`[Clubkonnect Service] Failed to load plans cache from Firestore: ${dbErr.message}`);
      }
    }

    if (networkName) {
      const normalizedNetwork = networkName.trim().toUpperCase();
      return dataPlanCache.plans[normalizedNetwork] || [];
    }

    return Object.values(dataPlanCache.plans).flat();
  }

  /**
   * Fetches the wallet balance from Clubkonnect with timeout, logging, and automatic retries.
   * Calls: GET https://www.nellobytesystems.com/APIWalletBalanceV1.asp
   */
  static async getWalletBalance(requestId?: string): Promise<ClubkonnectBalanceResponse> {
    const { BASE_URL, USER_ID, API_KEY } = clubkonnectConfig;

    if (!USER_ID || !API_KEY) {
      throw new Error("Clubkonnect credentials (CLUBKONNECT_USER_ID or CLUBKONNECT_API_KEY) are not configured.");
    }

    const url = `${BASE_URL}/APIWalletBalanceV1.asp?UserID=${encodeURIComponent(USER_ID)}&APIKey=${encodeURIComponent(API_KEY)}`;
    const timeout = 10000;
    const maxRetries = 2;

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
          headers: DEFAULT_CLUBKONNECT_HEADERS,
        });
      } catch (requestError: any) {
        attempt++;
        logger.error(
          `[Clubkonnect Service] Network/HTTP error fetching Clubkonnect balance (attempt ${attempt}/${maxRetries + 1}) | error=${requestError.message} | reqId=${requestId}`
        );

        if (attempt > maxRetries) {
          throw new Error(`Failed to retrieve wallet balance from Clubkonnect after ${attempt} attempts. Original error: ${requestError.message}`);
        }
        continue;
      }

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
    const url = `${BASE_URL}/APIAirtimeV1.asp?UserID=${encodeURIComponent(USER_ID)}&APIKey=${encodeURIComponent(API_KEY)}&MobileNetwork=${encodeURIComponent(networkCode)}&Amount=${params.amount}&MobileNumber=${encodeURIComponent(params.phone)}&RequestID=${encodeURIComponent(params.requestId)}${cbParam}`;

    const timeout = 10000;
    const maxRetries = 2;

    let attempt = 0;
    while (true) {
      let response: AxiosResponse;

      try {
        const maskedKey = API_KEY.length > 5 ? `${API_KEY.slice(0, 3)}***${API_KEY.slice(-2)}` : "***";
        logger.info(
          `[Clubkonnect Service] Sending airtime purchase request | URL=${BASE_URL}/APIAirtimeV1.asp?UserID=${USER_ID}&APIKey=${maskedKey}&MobileNetwork=${networkCode}&Amount=${params.amount}&MobileNumber=${params.phone}&RequestID=${params.requestId} | attempt=${attempt + 1}/${maxRetries + 1} | reqId=${requestId}`
        );

        response = await axios.get(url, {
          timeout,
          headers: DEFAULT_CLUBKONNECT_HEADERS,
        });
      } catch (requestError: any) {
        attempt++;
        const errStatus = requestError.response?.status || "NO_STATUS";

        if (attempt > maxRetries) {
          throw new Error(`Failed to complete airtime purchase from Clubkonnect after ${attempt} attempts. Provider status: ${errStatus}. Original error: ${requestError.message}`);
        }
        continue;
      }

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
   * Executes a mobile data plan purchase on Clubkonnect API with dual endpoint failover:
   * Attempt 1: APIDatabundleV1.asp
   * Attempt 2 (Failover on 503 / HTTP Error): APIDatashareV1.asp
   */
  static async purchaseData(params: PurchaseDataParams, requestId?: string): Promise<DataResponse> {
    const { BASE_URL, USER_ID, API_KEY } = clubkonnectConfig;

    if (!USER_ID || !API_KEY) {
      throw new Error("Clubkonnect credentials (CLUBKONNECT_USER_ID or CLUBKONNECT_API_KEY) are not configured.");
    }

    const networkCode = await this.getNetworkCode(params.network, requestId);
    const cbParam = params.callbackUrl ? `&CallBackURL=${encodeURIComponent(params.callbackUrl)}` : "";

    const primaryUrl = `${BASE_URL}/APIDatabundleV1.asp?UserID=${encodeURIComponent(USER_ID)}&APIKey=${encodeURIComponent(API_KEY)}&MobileNetwork=${encodeURIComponent(networkCode)}&DataPlan=${encodeURIComponent(params.planCode)}&MobileNumber=${encodeURIComponent(params.phone)}&RequestID=${encodeURIComponent(params.requestId)}${cbParam}`;
    const failoverUrl = `${BASE_URL}/APIDatashareV1.asp?UserID=${encodeURIComponent(USER_ID)}&APIKey=${encodeURIComponent(API_KEY)}&MobileNetwork=${encodeURIComponent(networkCode)}&DataPlan=${encodeURIComponent(params.planCode)}&MobileNumber=${encodeURIComponent(params.phone)}&RequestID=${encodeURIComponent(params.requestId)}${cbParam}`;

    const timeout = 10000;
    const endpointsToTry = [
      { name: "APIDatabundleV1.asp", url: primaryUrl },
      { name: "APIDatashareV1.asp", url: failoverUrl },
    ];

    let lastErrorMessage = "";

    for (const endpoint of endpointsToTry) {
      try {
        const maskedKey = API_KEY.length > 5 ? `${API_KEY.slice(0, 3)}***${API_KEY.slice(-2)}` : "***";
        logger.info(
          `[Clubkonnect Service] Sending mobile data purchase request via ${endpoint.name} | MobileNetwork=${networkCode}&DataPlan=${params.planCode}&MobileNumber=${params.phone}&RequestID=${params.requestId} | reqId=${requestId}`
        );

        const response: AxiosResponse = await axios.get(endpoint.url, {
          timeout,
          headers: DEFAULT_CLUBKONNECT_HEADERS,
        });

        const data = response.data;
        if (data && typeof data === "object") {
          const status = String(data.status || "").trim().toUpperCase();
          if (status === "ORDER_RECEIVED") {
            logger.info(`[Clubkonnect Service] Mobile data order received successfully via ${endpoint.name} | orderId=${data.orderid}`);
            return {
              success: true,
              orderId: data.orderid ? String(data.orderid) : undefined,
              status: "Pending",
              message: data.remark || "Data order accepted successfully.",
            };
          } else {
            lastErrorMessage = data.remark || data.remark_desc || `Rejected by ${endpoint.name} with status: ${data.status}`;
            logger.warn(`[Clubkonnect Service] ${endpoint.name} returned status: ${status} | message=${lastErrorMessage}`);
          }
        }
      } catch (requestError: any) {
        const errStatus = requestError.response?.status || "NO_STATUS";
        lastErrorMessage = `HTTP ${errStatus}: ${requestError.message}`;
        logger.error(
          `[Clubkonnect Service] Error calling ${endpoint.name} | HTTP Status=${errStatus} | error=${requestError.message}. Attempting failover if available...`
        );
      }
    }

    return {
      success: false,
      status: "Failed",
      message: lastErrorMessage || "All Clubkonnect mobile data endpoints failed.",
    };
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

    const url = `${BASE_URL}/APIQueryV1.asp?UserID=${encodeURIComponent(USER_ID)}&APIKey=${encodeURIComponent(API_KEY)}${queryParam}`;
    const timeout = 10000;

    try {
      const response: AxiosResponse = await axios.get(url, {
        timeout,
        headers: DEFAULT_CLUBKONNECT_HEADERS,
      });

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
