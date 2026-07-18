import { Request, Response, NextFunction } from "express";
import { z } from "zod";
import logger from "../config/logger";
import { AccountResolutionService } from "../services/accountResolutionService";

// Zod Schema for account resolution
const resolveAccountSchema = z.object({
  account_number: z.string().regex(/^\d+$/, "Account number must contain only digits").min(5, "Account number is too short").max(15, "Account number is too long"),
  bank_code: z.string().regex(/^\d+$/, "Bank code must contain only digits").min(3, "Bank code is too short").max(10, "Bank code is too long"),
});

export const resolveAccount = async (req: Request, res: Response, next: NextFunction) => {
  const reqId = req.requestId;
  logger.info(`[Flutterwave Controller] Received resolveAccount request | reqId=${reqId}`);

  try {
    // 1. Validate request body using Zod
    const validationResult = resolveAccountSchema.safeParse(req.body);
    if (!validationResult.success) {
      const errorMsg = validationResult.error.issues.map((e: z.ZodIssue) => e.message).join(", ");
      logger.warn(`[Flutterwave Controller] Validation failed | errors=${errorMsg} | reqId=${reqId}`);
      res.status(400).json({
        success: false,
        message: `Validation Error: ${errorMsg}`,
      });
      return;
    }

    const { account_number, bank_code } = validationResult.data;

    // 2. Execute Account Resolution
    const result = await AccountResolutionService.resolveBankAccount({
      account_number,
      bank_code,
      requestId: reqId,
    });

    if (result.success) {
      res.status(200).json({
        success: true,
        account_name: result.account_name,
        account_number: result.account_number,
        bank_code: result.bank_code,
      });
    } else {
      res.status(400).json({
        success: false,
        message: result.message || "Failed to resolve account details.",
      });
    }

  } catch (error: any) {
    logger.error(`[Flutterwave Controller] resolveAccount exception | error=${error.message} | reqId=${reqId}`);
    res.status(500).json({
      success: false,
      message: "An internal server error occurred.",
    });
  }
};

export const initiateTransfer = async (req: Request, res: Response, next: NextFunction) => {
  try {
    logger.info("[Flutterwave Controller] initiateTransfer stub called");
    res.status(501).json({
      success: false,
      message: "Single transfer is not implemented yet in this phase.",
    });
  } catch (error) {
    next(error);
  }
};

export const initiateBulkTransfer = async (req: Request, res: Response, next: NextFunction) => {
  try {
    logger.info("[Flutterwave Controller] initiateBulkTransfer stub called");
    res.status(501).json({
      success: false,
      message: "Bulk transfer is not implemented yet in this phase.",
    });
  } catch (error) {
    next(error);
  }
};

export const createVirtualAccount = async (req: Request, res: Response, next: NextFunction) => {
  try {
    logger.info("[Flutterwave Controller] createVirtualAccount stub called");
    res.status(501).json({
      success: false,
      message: "Virtual account creation is not implemented yet in this phase.",
    });
  } catch (error) {
    next(error);
  }
};

export const verifyPayment = async (req: Request, res: Response, next: NextFunction) => {
  try {
    logger.info("[Flutterwave Controller] verifyPayment stub called");
    res.status(501).json({
      success: false,
      message: "Payment verification is not implemented yet in this phase.",
    });
  } catch (error) {
    next(error);
  }
};

export const handleWebhook = async (req: Request, res: Response, next: NextFunction) => {
  try {
    logger.info("[Flutterwave Controller] handleWebhook stub called");
    res.status(501).json({
      success: false,
      message: "Webhook verification is not implemented yet in this phase.",
    });
  } catch (error) {
    next(error);
  }
};
