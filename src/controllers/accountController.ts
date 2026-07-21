import { Request, Response, NextFunction } from "express";
import { z } from "zod";
import logger from "../config/logger";
import { AccountResolutionService } from "../services/accountResolutionService";

// Strict Zod Validation Schema
const smartResolveAccountSchema = z.object({
  accountNumber: z.string()
    .trim()
    .regex(/^\d{10}$/, "Account number must be exactly 10 digits"),
  bankCode: z.string()
    .trim()
    .min(1, "Bank code is required")
    .regex(/^\d+$/, "Bank code must contain only digits"),
});

// Simple In-Memory Cache with a maximum of 500 entries (LRU-ish eviction)
const RESOLUTION_CACHE = new Map<string, { accountName: string; timestamp: number }>();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes caching TTL
const MAX_CACHE_SIZE = 500;

// Deduplication map for in-flight requests (prevents duplicate API queries for same bank/account in progress)
const IN_FLIGHT_RESOLUTIONS = new Map<string, Promise<any>>();

export const resolveAccount = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const reqId = req.requestId;
  logger.info(`[Smart Account Resolution] Received resolve request | reqId=${reqId}`);
  logger.info(`[Smart Account Resolution] Raw request body:`, req.body);

  try {
    // 1. Sanitize & Normalize Input
    const sanitizedAccountNumber = typeof req.body.accountNumber === "string" ? req.body.accountNumber.trim() : "";
    const sanitizedBankCode = typeof req.body.bankCode === "string" ? req.body.bankCode.trim() : "";

    const normalizedBody = {
      accountNumber: sanitizedAccountNumber,
      bankCode: sanitizedBankCode,
    };

    logger.info(`[Smart Account Resolution] Normalized request body:`, normalizedBody);

    // 2. Validate Inputs
    const validationResult = smartResolveAccountSchema.safeParse(normalizedBody);
    if (!validationResult.success) {
      const errorMsg = validationResult.error.issues.map((e: z.ZodIssue) => e.message).join(", ");
      logger.warn(`[Smart Account Resolution] Validation failed | errors=${errorMsg} | reqId=${reqId}`);
      res.status(400).json({
        success: false,
        message: `Validation Error: ${errorMsg}`,
      });
      return;
    }

    const { accountNumber, bankCode } = validationResult.data;
    const cacheKey = `${bankCode}-${accountNumber}`;

    // 3. Cache Hit Check
    const cachedEntry = RESOLUTION_CACHE.get(cacheKey);
    if (cachedEntry && (Date.now() - cachedEntry.timestamp < CACHE_TTL_MS)) {
      logger.info(`[Smart Account Resolution] Cache Hit! | key=${cacheKey} | reqId=${reqId}`);
      res.status(200).json({
        success: true,
        bankCode,
        accountNumber,
        accountName: cachedEntry.accountName,
      });
      return;
    }

    // 4. Request Deduplication (In-Flight Coalescing)
    let resolutionPromise = IN_FLIGHT_RESOLUTIONS.get(cacheKey);
    if (resolutionPromise) {
      logger.info(`[Smart Account Resolution] Deduplicating request. Coalescing on in-flight resolution | key=${cacheKey} | reqId=${reqId}`);
      try {
        const result = await resolutionPromise;
        res.status(200).json({
          success: true,
          bankCode,
          accountNumber,
          accountName: result.accountName,
        });
      } catch (err: any) {
        res.status(400).json({
          success: false,
          message: err.message || "Unable to resolve account.",
        });
      }
      return;
    }

    // 5. Create new In-Flight Resolution Promise
    const resolveTask = async () => {
      logger.info(`[Smart Account Resolution] Dispatching resolution request to Flutterwave | key=${cacheKey} | reqId=${reqId}`);
      const serviceResult = await AccountResolutionService.resolveBankAccount({
        account_number: accountNumber,
        bank_code: bankCode,
        requestId: reqId,
      });

      if (!serviceResult.success || !serviceResult.account_name) {
        throw new Error(serviceResult.message || "Unable to resolve account.");
      }

      return {
        accountName: serviceResult.account_name,
      };
    };

    const taskPromise = resolveTask();
    IN_FLIGHT_RESOLUTIONS.set(cacheKey, taskPromise);

    try {
      const result = await taskPromise;

      // 6. Cache the successful result
      if (RESOLUTION_CACHE.size >= MAX_CACHE_SIZE) {
        const oldestKey = RESOLUTION_CACHE.keys().next().value;
        if (oldestKey) RESOLUTION_CACHE.delete(oldestKey);
      }

      RESOLUTION_CACHE.set(cacheKey, {
        accountName: result.accountName,
        timestamp: Date.now(),
      });

      logger.info(`[Smart Account Resolution] Resolution completed successfully | name=${result.accountName} | reqId=${reqId}`);

      res.status(200).json({
        success: true,
        bankCode,
        accountNumber,
        accountName: result.accountName,
      });

    } catch (error: any) {
      logger.warn(`[Smart Account Resolution] Resolution failed | error=${error.message} | reqId=${reqId}`);
      res.status(400).json({
        success: false,
        message: "Unable to resolve account.",
      });
    } finally {
      // Cleanup in-flight request tracker
      IN_FLIGHT_RESOLUTIONS.delete(cacheKey);
    }

  } catch (error: any) {
    logger.error(`[Smart Account Resolution] Unexpected exception | error=${error.message} | reqId=${reqId}`);
    res.status(500).json({
      success: false,
      message: "An internal server error occurred.",
    });
  }
};
