import { getFlutterwaveClient } from "../providers/flutterwave";
import logger from "../config/logger";
import * as fs from "fs";
import * as path from "path";

export interface Bank {
  id: number;
  code: string;
  name: string;
  logoUrl?: string | null;
}

// In-memory cache dictionaries
const logoMapping: Record<string, string> = {};
const nameToLogoMapping: Record<string, string> = {};

function normalizeBankName(name: string): string {
  if (!name) return "";
  let clean = name.toLowerCase().trim();
  
  // Custom aliases for perfect matching
  if (clean.includes("gtbank") || clean.includes("gtb") || clean.includes("guaranty trust")) {
    return "gtb";
  }
  if (clean.includes("uba") || clean.includes("united bank for africa")) {
    return "uba";
  }
  if (clean.includes("first bank") || clean.includes("firstbank")) {
    return "firstbank";
  }
  if (clean.includes("opay")) {
    return "opay";
  }
  if (clean.includes("moniepoint")) {
    return "moniepoint";
  }
  if (clean.includes("palmpay") || clean.includes("palm pay")) {
    return "palmpay";
  }
  if (clean.includes("access")) {
    return "access";
  }
  if (clean.includes("zenith")) {
    return "zenith";
  }
  if (clean.includes("fidelity")) {
    return "fidelity";
  }
  if (clean.includes("union")) {
    return "union";
  }
  if (clean.includes("stanbic")) {
    return "stanbic";
  }
  if (clean.includes("sterling")) {
    return "sterling";
  }
  if (clean.includes("wema")) {
    return "wema";
  }

  // Remove common banking suffixes/puncs
  clean = clean.replace(/[^a-z0-9]/g, " ");
  clean = clean.replace(/\b(bank|limited|ltd|plc|microfinance|mfb|cooperative|merchant|service|services|mobile|gateway|national)\b/g, "");
  return clean.replace(/\s+/g, "").trim();
}

export class BankCacheService {
  private static instance: BankCacheService;
  private cachedBanks: Bank[] = [];
  private lastUpdated: Date | null = null;
  private cacheTTLMs = 24 * 60 * 60 * 1000; // 24 hours

  private constructor() {
    // 1. Initial logo seeding from static file
    this.seedLogosFromFile();

    // 2. Perform initial fetch in the background on startup
    this.refreshBanks().catch((err) => {
      logger.error(`[BankCacheService] Initial startup refresh failed: ${err.message}`);
    });

    // 3. Daily refresh loop
    setInterval(async () => {
      logger.info("[BankCacheService] Triggering automatic daily background refresh of bank list...");
      try {
        await this.refreshBanks();
        logger.info("[BankCacheService] Automatic daily background refresh succeeded.");
      } catch (err: any) {
        logger.error(`[BankCacheService] Automatic daily background refresh failed: ${err.message}`);
      }
    }, 24 * 60 * 60 * 1000);
  }

  public static getInstance(): BankCacheService {
    if (!BankCacheService.instance) {
      BankCacheService.instance = new BankCacheService();
    }
    return BankCacheService.instance;
  }

  private seedLogosFromFile() {
    try {
      const filePath = path.join(__dirname, "../config/nigerian_banks_logos.json");
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, "utf8");
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          arr.forEach((item: any) => {
            if (item.code && item.logo) {
              let codeStr = item.code.toString().trim();
              if (/^\d+$/.test(codeStr)) {
                codeStr = codeStr.padStart(3, "0");
              }
              logoMapping[codeStr] = item.logo;
            }
            if (item.name && item.logo) {
              nameToLogoMapping[normalizeBankName(item.name)] = item.logo;
            }
          });
          logger.info(`[BankCacheService] Successfully parsed ${arr.length} bank logos from static dataset.`);
        }
      } else {
        logger.warn(`[BankCacheService] Static logos file not found at ${filePath}. Will fetch on API calls.`);
      }
    } catch (err: any) {
      logger.error(`[BankCacheService] Failed to load static logo mapping: ${err.message}`);
    }
  }

  public async refreshLogosFromAPI(): Promise<void> {
    try {
      logger.info("[BankCacheService] Attempting online refresh of bank logos dataset...");
      const response = await fetch("https://jsanwo64.github.io/Nigeria-Banks-Logo-API/Banks.json");
      if (response.ok) {
        const arr = await response.json();
        if (Array.isArray(arr)) {
          arr.forEach((item: any) => {
            if (item.code && item.logo) {
              let codeStr = item.code.toString().trim();
              if (/^\d+$/.test(codeStr)) {
                codeStr = codeStr.padStart(3, "0");
              }
              logoMapping[codeStr] = item.logo;
            }
            if (item.name && item.logo) {
              nameToLogoMapping[normalizeBankName(item.name)] = item.logo;
            }
          });
          logger.info(`[BankCacheService] Refreshed ${arr.length} bank logos from online API.`);
          
          // Persist to static file as self-healing cache
          const filePath = path.join(__dirname, "../config/nigerian_banks_logos.json");
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          fs.writeFileSync(filePath, JSON.stringify(arr, null, 2), "utf8");
        }
      }
    } catch (err: any) {
      logger.warn(`[BankCacheService] Failed to fetch online bank logos JSON: ${err.message}`);
    }
  }

  /**
   * Fetches fresh bank list directly from Flutterwave, sorts them alphabetically, and replaces the cache.
   */
  public async refreshBanks(): Promise<Bank[]> {
    logger.info("[BankCacheService] Querying Flutterwave for latest bank list (GET /banks/NG)...");
    try {
      // Background fetch to make sure logos mapping is always up to date
      this.refreshLogosFromAPI().catch((err) => {
        logger.warn(`[BankCacheService] Online logos fetch failed: ${err.message}`);
      });

      const client = getFlutterwaveClient();
      const response = await client.request("get", "/banks/NG");

      if (response && response.status === "success" && Array.isArray(response.data)) {
        const rawBanks = response.data as Bank[];
        
        // Sort and map bank details with logos
        const sortedBanks = rawBanks.map((bank: Bank) => {
          let codeStr = (bank.code || "").trim();
          if (/^\d+$/.test(codeStr)) {
            codeStr = codeStr.padStart(3, "0");
          }
          
          // 1. Match by code first
          let logoUrl = logoMapping[codeStr] || null;
          
          // 2. Fallback to name-based match
          if (!logoUrl && bank.name) {
            logoUrl = nameToLogoMapping[normalizeBankName(bank.name)] || null;
          }

          // Ensure logo is HTTPS only for security
          if (logoUrl && logoUrl.startsWith("http://")) {
            logoUrl = logoUrl.replace("http://", "https://");
          }

          return {
            id: bank.id,
            code: bank.code,
            name: bank.name,
            logoUrl
          };
        }).sort((a, b) => {
          const nameA = (a.name || "").trim().toLowerCase();
          const nameB = (b.name || "").trim().toLowerCase();
          return nameA.localeCompare(nameB);
        });

        this.cachedBanks = sortedBanks;
        this.lastUpdated = new Date();
        logger.info(`[BankCacheService] Refresh success: ${sortedBanks.length} banks loaded and sorted alphabetically.`);
        return sortedBanks;
      } else {
        throw new Error(response?.message || "Invalid response format from payment provider.");
      }
    } catch (error: any) {
      logger.error(`[BankCacheService] Refresh failure: ${error.message}`);
      throw error;
    }
  }

  /**
   * Retrieves the bank list. Handles TTL expiration, automatic fallback if Flutterwave is down,
   * and reports cache hits and misses.
   */
  public async getBanks(): Promise<{ success: boolean; status?: string; updatedAt: string; cached: boolean; count: number; data: Bank[] }> {
    const now = Date.now();
    const isExpired = !this.lastUpdated || (now - this.lastUpdated.getTime() > this.cacheTTLMs);

    if (isExpired || this.cachedBanks.length === 0) {
      logger.info("[BankCacheService] Cache miss (either expired or uninitialized). Fetching fresh list...");
      try {
        await this.refreshBanks();
        return {
          success: true,
          status: "success",
          updatedAt: this.lastUpdated?.toISOString() || new Date().toISOString(),
          cached: false,
          count: this.cachedBanks.length,
          data: this.cachedBanks,
        };
      } catch (err: any) {
        if (this.cachedBanks.length > 0) {
          logger.warn(`[BankCacheService] Flutterwave temporarily offline: Falling back to expired cached version. error=${err.message}`);
          return {
            success: true,
            status: "success",
            updatedAt: this.lastUpdated?.toISOString() || new Date().toISOString(),
            cached: true,
            count: this.cachedBanks.length,
            data: this.cachedBanks,
          };
        } else {
          logger.error("[BankCacheService] Flutterwave offline and no cached version exists.");
          throw err;
        }
      }
    }

    logger.info("[BankCacheService] Cache hit: Returning active cached banks.");
    return {
      success: true,
      status: "success",
      updatedAt: this.lastUpdated?.toISOString() || new Date().toISOString(),
      cached: true,
      count: this.cachedBanks.length,
      data: this.cachedBanks,
    };
  }
}
