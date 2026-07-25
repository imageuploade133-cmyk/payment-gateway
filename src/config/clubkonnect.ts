import dotenv from "dotenv";
import logger from "./logger";

dotenv.config();

export interface ClubkonnectConfig {
  BASE_URL: string;
  USER_ID: string;
  API_KEY: string;
}

function validateClubkonnectConfig(): ClubkonnectConfig {
  const BASE_URL = process.env.CLUBKONNECT_BASE_URL || "https://www.nellobytesystems.com";
  const USER_ID = process.env.CLUBKONNECT_USER_ID;
  const API_KEY = process.env.CLUBKONNECT_API_KEY;

  if (!USER_ID || !API_KEY) {
    logger.warn(`[Clubkonnect Config] Configuration Warning: Missing CLUBKONNECT_USER_ID or CLUBKONNECT_API_KEY in environment.`);
  }

  return {
    BASE_URL,
    USER_ID: USER_ID || "",
    API_KEY: API_KEY || "",
  };
}

export const clubkonnectConfig = validateClubkonnectConfig();

// Hardcoded default network mappings as reliable fallback
export const DEFAULT_NETWORK_MAPPINGS: Record<string, string> = {
  "MTN": "01",
  "GLO": "02",
  "9MOBILE": "03",
  "ETISALAT": "03",
  "AIRTEL": "04",
};

// Network Cache configuration
export interface NetworkCache {
  mappings: Record<string, string>;
  lastFetched: number;
}

export const networkCache: NetworkCache = {
  mappings: { ...DEFAULT_NETWORK_MAPPINGS },
  lastFetched: 0,
};

// Hardcoded default data plan packages as reliable fallback
export const DEFAULT_DATA_PLANS: Record<string, any[]> = {
  "MTN": [
    { item_code: "mtn_500mb", name: "MTN 500MB (SME Datashare) - 30 Days", amount: 150, plan_code: "1" },
    { item_code: "mtn_1gb", name: "MTN 1GB (SME Datashare) - 30 Days", amount: 280, plan_code: "2" },
    { item_code: "mtn_2gb", name: "MTN 2GB (SME Datashare) - 30 Days", amount: 560, plan_code: "3" },
    { item_code: "mtn_5gb", name: "MTN 5GB (SME Datashare) - 30 Days", amount: 1400, plan_code: "4" },
    { item_code: "mtn_10gb", name: "MTN 10GB (SME Datashare) - 30 Days", amount: 2800, plan_code: "5" },
  ],
  "GLO": [
    { item_code: "glo_1gb", name: "Glo 1.05GB - 14 Days", amount: 450, plan_code: "glo-1" },
    { item_code: "glo_2gb", name: "Glo 2.9GB - 30 Days", amount: 900, plan_code: "glo-2" },
    { item_code: "glo_5gb", name: "Glo 5.8GB - 30 Days", amount: 1350, plan_code: "glo-3" },
  ],
  "AIRTEL": [
    { item_code: "airtel_1gb", name: "Airtel 1GB - 30 Days", amount: 350, plan_code: "airtel-1" },
    { item_code: "airtel_2gb", name: "Airtel 2GB - 30 Days", amount: 700, plan_code: "airtel-2" },
    { item_code: "airtel_5gb", name: "Airtel 5GB - 30 Days", amount: 1400, plan_code: "airtel-3" },
  ],
  "9MOBILE": [
    { item_code: "9mob_1gb", name: "9mobile 1GB - 30 Days", amount: 400, plan_code: "9mob-1" },
    { item_code: "9mob_2gb", name: "9mobile 2GB - 30 Days", amount: 800, plan_code: "9mob-2" },
  ]
};

// Data Plan Cache configuration
export interface DataPlanCache {
  plans: Record<string, any[]>;
  lastFetched: number;
}

export const dataPlanCache: DataPlanCache = {
  plans: { ...DEFAULT_DATA_PLANS },
  lastFetched: 0,
};
