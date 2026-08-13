import { getFlutterwaveClient } from "../providers/flutterwave";
import logger from "../config/logger";

export interface Bank {
  id: number;
  code: string;
  name: string;
}

export class BankCacheService {
  private static instance: BankCacheService;
  private cachedBanks: Bank[] = [];
  private lastUpdated: Date | null = null;
  private cacheTTLMs = 24 * 60 * 60 * 1000; // 24 hours

  private constructor() {
    // Automatically perform initial fetch in the background on startup
    this.refreshBanks().catch((err) => {
      logger.error(`[BankCacheService] Initial startup refresh failed: ${err.message}`);
    });

    // Automatically trigger daily refresh every 24 hours to keep cached banks evergreen (Even better architecture!)
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

  /**
   * Fetches fresh bank list directly from Flutterwave, sorts them alphabetically, and replaces the cache.
   */
  public async refreshBanks(): Promise<Bank[]> {
    logger.info("[BankCacheService] Querying Flutterwave for latest bank list (GET /banks/NG)...");
    try {
      const client = getFlutterwaveClient();
      const response = await client.request("get", "/banks/NG");

      if (response && response.status === "success" && Array.isArray(response.data)) {
        const rawBanks = response.data as Bank[];
        
        // Sort banks alphabetically by name
        const sortedBanks = rawBanks.sort((a, b) => {
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
