import dotenv from "dotenv";
import logger from "./logger";

dotenv.config();

export interface ClubkonnectConfig {
  BASE_URL: string;
  USER_ID: string;
  API_KEY: string;
}

class DynamicClubkonnectConfig implements ClubkonnectConfig {
  private customUserId?: string;
  private customApiKey?: string;
  private customBaseUrl?: string;

  get BASE_URL(): string {
    return this.customBaseUrl || process.env.CLUBKONNECT_BASE_URL || "https://www.nellobytesystems.com";
  }

  set BASE_URL(val: string) {
    this.customBaseUrl = val;
  }

  get USER_ID(): string {
    return this.customUserId !== undefined ? this.customUserId : (process.env.CLUBKONNECT_USER_ID || "");
  }

  set USER_ID(val: string) {
    this.customUserId = val;
  }

  get API_KEY(): string {
    return this.customApiKey !== undefined ? this.customApiKey : (process.env.CLUBKONNECT_API_KEY || "");
  }

  set API_KEY(val: string) {
    this.customApiKey = val;
  }
}

export const clubkonnectConfig: ClubkonnectConfig = new DynamicClubkonnectConfig();

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
