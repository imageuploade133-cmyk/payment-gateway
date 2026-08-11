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

// Hardcoded default data plan packages as reliable fallback (De-hardcoded for fully dynamic fetch)
export const DEFAULT_DATA_PLANS: Record<string, any[]> = {
  "MTN": [],
  "GLO": [],
  "AIRTEL": [],
  "9MOBILE": []
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
