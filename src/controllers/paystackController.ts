import { Request, Response, NextFunction } from "express";
import { z } from "zod";
import logger from "../config/logger";
import { PaystackService } from "../services/paystackService";
import { getPaystackClient } from "../providers/paystack";
import { FirestoreIdempotency } from "../services/firestoreIdempotency";

// Zod Schemas
const resolveAccountSchema = z.object({
  account_number: z.string().regex(/^\d+$/, "Account number must contain only digits").min(5, "Account number is too short").max(15, "Account number is too long"),
  bank_code: z.string().regex(/^\d+$/, "Bank code must contain only digits").min(3, "Bank code is too short").max(10, "Bank code is too long"),
});

const transferSchema = z.object({
  amount: z.number().positive("Amount must be greater than zero"),
  account_number: z.string().regex(/^\d+$/, "Account number must contain only digits").min(5, "Account number is too short").max(15, "Account number is too long"),
  bank_code: z.string().regex(/^\d+$/, "Bank code must contain only digits").min(3, "Bank code is too short").max(10, "Bank code is too long"),
  account_name: z.string().min(2, "Account name is required"),
  currency: z.string().length(3, "Currency must be a 3-letter code (e.g. NGN)"),
  narration: z.string().min(1, "Narration is required"),
  reference: z.string().min(3, "Reference is required"),
});

const verifyPaymentSchema = z.object({
  transaction_id: z.string().min(1, "transaction_id is required"),
});

export const initializePayment = async (req: Request, res: Response, next: NextFunction) => {
  // Paystack initialization stub (if requested)
  res.status(501).json({
    success: false,
    message: "Initialization is not implemented yet in this phase.",
  });
};

export const resolveAccount = async (req: Request, res: Response, next: NextFunction) => {
  const reqId = req.requestId;
  logger.info(`[Paystack Controller] Received resolveAccount request | reqId=${reqId}`);
  logger.info("Resolve request body:", req.body);

  try {
    const body = {
      account_number: req.body.account_number ?? req.body.accountNumber,
      bank_code: req.body.bank_code ?? req.body.bankCode ?? req.body.account_bank ?? req.body.accountBank,
    };
    logger.info("Normalized body:", body);

    const validationResult = resolveAccountSchema.safeParse(body);
    if (!validationResult.success) {
      const errorMsg = validationResult.error.issues.map((e: z.ZodIssue) => e.message).join(", ");
      logger.warn(`[Paystack Controller] Validation failed | errors=${errorMsg} | reqId=${reqId}`);
      res.status(400).json({ success: false, message: `Validation Error: ${errorMsg}` });
      return;
    }

    const { account_number, bank_code } = validationResult.data;

    logger.info("Sending to Paystack:", {
      account_number,
      account_bank: bank_code
    });

    const result = await PaystackService.resolveAccount({
      account_number,
      bank_code,
      requestId: reqId,
    });

    if (result.success) {
      res.status(200).json(result);
    } else {
      res.status(400).json(result);
    }

  } catch (error: any) {
    logger.error(`[Paystack Controller] resolveAccount exception | error=${error.message} | reqId=${reqId}`);
    res.status(500).json({ success: false, message: "An internal server error occurred." });
  }
};

export const initiateTransfer = async (req: Request, res: Response, next: NextFunction) => {
  const reqId = req.requestId;
  logger.info(`[Paystack Controller] Received initiateTransfer request | reqId=${reqId}`);

  try {
    const validationResult = transferSchema.safeParse(req.body);
    if (!validationResult.success) {
      const errorMsg = validationResult.error.issues.map((e: z.ZodIssue) => e.message).join(", ");
      logger.warn(`[Paystack Controller] Transfer validation failed | errors=${errorMsg} | reqId=${reqId}`);
      res.status(400).json({ success: false, message: `Validation Error: ${errorMsg}` });
      return;
    }

    const payload = validationResult.data;

    const result = await PaystackService.executeTransfer({
      ...payload,
      requestId: reqId,
    });

    if (result.success) {
      res.status(200).json(result);
    } else {
      res.status(400).json(result);
    }

  } catch (error: any) {
    logger.error(`[Paystack Controller] initiateTransfer exception | error=${error.message} | reqId=${reqId}`);
    res.status(500).json({ success: false, message: "An internal server error occurred." });
  }
};

export const verifyPayment = async (req: Request, res: Response, next: NextFunction) => {
  const reqId = req.requestId;
  logger.info(`[Paystack Controller] Received verifyPayment request | reqId=${reqId}`);

  try {
    const validationResult = verifyPaymentSchema.safeParse(req.body);
    if (!validationResult.success) {
      const errorMsg = validationResult.error.issues.map((e: z.ZodIssue) => e.message).join(", ");
      logger.warn(`[Paystack Controller] Verify validation failed | errors=${errorMsg} | reqId=${reqId}`);
      res.status(400).json({ success: false, message: `Validation Error: ${errorMsg}` });
      return;
    }

    const { transaction_id } = validationResult.data;

    const result = await PaystackService.verifyTransaction({
      transaction_id,
      requestId: reqId,
    });

    if (result.success) {
      res.status(200).json(result);
    } else {
      res.status(400).json(result);
    }

  } catch (error: any) {
    logger.error(`[Paystack Controller] verifyPayment exception | error=${error.message} | reqId=${reqId}`);
    res.status(500).json({ success: false, message: "An internal server error occurred." });
  }
};

export const handleWebhook = async (req: Request, res: Response, next: NextFunction) => {
  const reqId = req.requestId;
  logger.info(`[Paystack Controller] Received Webhook request | reqId=${reqId}`);

  try {
    const signature = req.headers["x-paystack-signature"] as string || "";
    const rawBodyString = req.rawBody ? req.rawBody.toString("utf8") : JSON.stringify(req.body);

    const client = getPaystackClient();

    // 1. Signature validation
    const isValidSignature = client.verifyWebhookSignature(signature, rawBodyString);
    if (!isValidSignature) {
      logger.warn(`[Paystack Controller] Unauthorized Webhook Signature received | reqId=${reqId}`);
      res.status(401).json({ success: false, message: "Unauthorized signature hash mismatch." });
      return;
    }

    const payload = req.body;
    logger.info(`[Paystack Controller] Webhook signature verified successfully | event=${payload.event} | reqId=${reqId}`);

    // 2. Validate Event Type
    const eventType = payload.event;
    if (eventType !== "charge.success") {
      logger.info(`[Paystack Controller] Ignoring non-charge event: ${eventType} | reqId=${reqId}`);
      res.status(200).json({ success: true, message: "Webhook event ignored gracefully." });
      return;
    }

    // 3. Duplicate Webhook Protection (Firestore-backed)
    const transactionId = payload.data?.id?.toString() || payload.data?.reference;
    if (!transactionId) {
      logger.warn(`[Paystack Controller] Webhook payload missing transaction identifier | reqId=${reqId}`);
      res.status(400).json({ success: false, message: "Invalid webhook payload structure." });
      return;
    }

    const idempotency = FirestoreIdempotency.getInstance();
    const isDuplicate = await idempotency.isWebhookDuplicate(transactionId);
    if (isDuplicate) {
      logger.warn(`[Paystack Controller] Webhook already processed (Duplicate protection) | transactionId=${transactionId} | reqId=${reqId}`);
      res.status(200).json({ success: true, message: "Webhook already processed successfully." });
      return;
    }

    // Mark as processed in Firestore and memory immediately
    await idempotency.saveWebhookProcessed(transactionId, eventType, "paystack");

    logger.info(`[Paystack Controller] Webhook processed successfully | transactionId=${transactionId} | ref=${payload.data?.reference} | reqId=${reqId}`);

    res.status(200).json({
      success: true,
      message: "Webhook payload verified and captured.",
    });

  } catch (error: any) {
    logger.error(`[Paystack Controller] handleWebhook exception | error=${error.message} | reqId=${reqId}`);
    res.status(500).json({ success: false, message: "An internal server error occurred while handling webhook." });
  }
};
