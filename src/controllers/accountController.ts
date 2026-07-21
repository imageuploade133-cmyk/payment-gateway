import { Request, Response, NextFunction } from "express";
import { z } from "zod";
import logger from "../config/logger";
import { AccountResolutionService } from "../services/accountResolutionService";
import { getFlutterwaveClient } from "../providers/flutterwave";

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

// Cache for the complete banks list to avoid hitting Flutterwave /banks endpoint on every single discovery
let cachedBanksList: Array<{ id: number; code: string; name: string }> | null = null;
let cachedBanksTimestamp = 0;
const BANKS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // Cache banks list for 24 hours

export const resolveAccount = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const reqId = req.requestId;
  logger.info(`[Smart Account Resolution] Received resolve request | reqId=${reqId}`);
  logger.info(`[Smart Account Resolution] Raw request body:`, req.body);

  try {
    const sanitizedAccountNumber = typeof req.body.accountNumber === "string" ? req.body.accountNumber.trim() : "";
    const sanitizedBankCode = typeof req.body.bankCode === "string" ? req.body.bankCode.trim() : "";

    const normalizedBody = {
      accountNumber: sanitizedAccountNumber,
      bankCode: sanitizedBankCode,
    };

    logger.info(`[Smart Account Resolution] Normalized request body:`, normalizedBody);

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

/**
 * Implementation of the Central Bank of Nigeria's official NUBAN Check Digit validation algorithm.
 */
function isValidNuban(accountNumber: string, bankCode: string): boolean {
  if (accountNumber.length !== 10) return false;

  const cleanBankCode = bankCode.replace(/\D/g, "");
  const serialNumber = accountNumber.slice(0, 9);
  const checkDigit = Number(accountNumber.slice(9, 10));

  const multipliers = [3, 7, 3, 3, 7, 3, 3, 7, 3, 3, 7, 3];

  let fullCode = "";
  if (cleanBankCode.length === 3) {
    fullCode = cleanBankCode + serialNumber;
  } else if (cleanBankCode.length === 6) {
    fullCode = cleanBankCode.slice(-3) + serialNumber;
  } else {
    fullCode = cleanBankCode.padStart(3, "0") + serialNumber;
  }

  if (fullCode.length !== 12) return false;

  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += Number(fullCode[i]) * multipliers[i];
  }

  const remainder = sum % 10;
  const calculatedCheckDigit = remainder === 0 ? 0 : 10 - remainder;

  return calculatedCheckDigit === checkDigit;
}

/**
 * Smart Account Discovery Service.
 * Accepts only an accountNumber, matches against candidate banks locally via NUBAN algorithm,
 * and resolves details dynamically.
 */
export const discoverAccount = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const reqId = req.requestId;
  logger.info(`[Account Discovery] Received discover request | reqId=${reqId}`);
  logger.info(`[Account Discovery] Raw request body:`, req.body);

  try {
    const sanitizedAccountNumber = typeof req.body.accountNumber === "string" ? req.body.accountNumber.trim() : "";
    if (!sanitizedAccountNumber || !/^\d{10}$/.test(sanitizedAccountNumber)) {
      res.status(400).json({
        success: false,
        message: "Validation Error: Account number must be exactly 10 digits.",
      });
      return;
    }

    // 1. Fetch/Cache complete banks list from Flutterwave
    if (!cachedBanksList || (Date.now() - cachedBanksTimestamp > BANKS_CACHE_TTL_MS)) {
      try {
        logger.info(`[Account Discovery] Banks cache miss/expired. Loading banks list from Flutterwave...`);
        const client = getFlutterwaveClient();
        const banksRes = await client.request("get", "/banks/NG");
        if (banksRes && banksRes.status === "success" && Array.isArray(banksRes.data)) {
          cachedBanksList = banksRes.data;
          cachedBanksTimestamp = Date.now();
          logger.info(`[Account Discovery] Successfully cached ${cachedBanksList?.length} banks.`);
        }
      } catch (err: any) {
        logger.error(`[Account Discovery] Failed to fetch banks list: ${err.message}`);
      }
    }

    const banks = cachedBanksList || [];
    if (banks.length === 0) {
      res.status(503).json({
        success: false,
        message: "Banks lookup registry is temporarily unavailable.",
      });
      return;
    }

    // 2. Identify candidate banks using local CBN NUBAN algorithm
    const candidates = banks.filter((bank) => {
      if (!bank.code) return false;
      return isValidNuban(sanitizedAccountNumber, bank.code);
    });

    logger.info(`[Account Discovery] Found ${candidates.length} candidate banks for NUBAN ${sanitizedAccountNumber}:`, candidates.map(c => c.name));

    if (candidates.length === 0) {
      res.status(400).json({
        success: false,
        message: "Unable to detect any valid bank for this account number.",
      });
      return;
    }

    // 3. Perform account resolution queries sequentially on candidate list
    let resolvedBank = null;
    let resolvedName = "";

    for (const bank of candidates) {
      try {
        logger.info(`[Account Discovery] Querying candidate: ${bank.name} (${bank.code})`);
        const result = await AccountResolutionService.resolveBankAccount({
          account_number: sanitizedAccountNumber,
          bank_code: bank.code,
          requestId: reqId,
        });

        if (result.success && result.account_name) {
          resolvedBank = bank;
          resolvedName = result.account_name;
          logger.info(`[Account Discovery] Found verified bank match! | bank=${bank.name} | name=${resolvedName}`);
          break;
        }
      } catch (err: any) {
        logger.debug(`[Account Discovery] Candidate ${bank.name} resolution rejected: ${err.message}`);
      }
    }

    if (resolvedBank && resolvedName) {
      res.status(200).json({
        success: true,
        bankCode: resolvedBank.code,
        bankName: resolvedBank.name,
        accountName: resolvedName,
        accountNumber: sanitizedAccountNumber,
      });
    } else {
      res.status(400).json({
        success: false,
        message: "Unable to resolve bank account details.",
      });
    }

  } catch (error: any) {
    logger.error(`[Account Discovery] Unexpected exception | error=${error.message} | reqId=${reqId}`);
    res.status(500).json({
      success: false,
      message: "An internal server error occurred.",
    });
  }
};
