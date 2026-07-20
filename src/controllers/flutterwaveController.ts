import { Request, Response, NextFunction } from "express";
import { z } from "zod";
import logger from "../config/logger";
import { AccountResolutionService } from "../services/accountResolutionService";
import { TransferService } from "../services/transferService";
import { PaymentVerificationService } from "../services/paymentVerificationService";
import { getFlutterwaveClient } from "../providers/flutterwave";
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

const createVirtualAccountSchema = z.object({
  email: z.string().email("Invalid email address"),
  is_permanent: z.boolean(),
  bvn: z.string().regex(/^\d*$/, "BVN must contain only digits").max(11, "BVN must be up to 11 digits").optional().or(z.literal("")),
  tx_ref: z.string().min(3, "tx_ref is required"),
  phonenumber: z.string().min(5, "Phone number is too short"),
  firstname: z.string().min(1, "Firstname is required"),
  lastname: z.string().min(1, "Lastname is required"),
});

const verifyPaymentSchema = z.object({
  transaction_id: z.string().min(1, "transaction_id is required"),
});

const initializePaymentSchema = z.object({
  amount: z.number().positive(),
  currency: z.string(),
  email: z.string().email(),
  name: z.string(),
  userId: z.string(),
  redirectUrl: z.string(),
  phone: z.string().optional(),
});

const transferService = new TransferService();

export const resolveAccount = async (req: Request, res: Response, next: NextFunction) => {
  const reqId = req.requestId;
  logger.info(`[Flutterwave Controller] Received resolveAccount request | reqId=${reqId}`);
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
      logger.warn(`[Flutterwave Controller] Validation failed | errors=${errorMsg} | reqId=${reqId}`);
      res.status(400).json({
        success: false,
        message: `Validation Error: ${errorMsg}`,
      });
      return;
    }

    const { account_number, bank_code } = validationResult.data;

    logger.info("Sending to Flutterwave:", {
      account_number,
      account_bank: bank_code
    });

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
  const reqId = req.requestId;
  logger.info(`[Flutterwave Controller] Received initiateTransfer request | reqId=${reqId}`);

  try {
    const validationResult = transferSchema.safeParse(req.body);
    if (!validationResult.success) {
      const errorMsg = validationResult.error.issues.map((e: z.ZodIssue) => e.message).join(", ");
      logger.warn(`[Flutterwave Controller] Transfer validation failed | errors=${errorMsg} | reqId=${reqId}`);
      res.status(400).json({
        success: false,
        message: `Validation Error: ${errorMsg}`,
      });
      return;
    }

    const payload = validationResult.data;

    const result = await transferService.executeTransfer({
      ...payload,
      requestId: reqId,
    });

    if (result.success) {
      res.status(200).json({
        success: true,
        reference: result.reference,
        provider_reference: result.provider_reference,
        status: result.status,
        message: result.message || "Transfer initiated successfully.",
      });
    } else {
      res.status(400).json({
        success: false,
        reference: result.reference,
        message: result.message || "Failed to process outward transfer.",
      });
    }

  } catch (error: any) {
    logger.error(`[Flutterwave Controller] initiateTransfer exception | error=${error.message} | reqId=${reqId}`);
    res.status(500).json({
      success: false,
      message: "An internal server error occurred while processing transfer.",
    });
  }
};

export const createVirtualAccount = async (req: Request, res: Response, next: NextFunction) => {
  const reqId = req.requestId;
  logger.info(`[Flutterwave Controller] Received createVirtualAccount request | reqId=${reqId}`);

  try {
    const validationResult = createVirtualAccountSchema.safeParse(req.body);
    if (!validationResult.success) {
      const errorMsg = validationResult.error.issues.map((e: z.ZodIssue) => e.message).join(", ");
      logger.warn(`[Flutterwave Controller] Create Virtual Account validation failed | errors=${errorMsg} | reqId=${reqId}`);
      res.status(400).json({
        success: false,
        message: `Validation Error: ${errorMsg}`,
      });
      return;
    }

    const payload = validationResult.data;

    const result = await PaymentVerificationService.createVirtualAccount({
      ...payload,
      bvn: payload.bvn || "",
      requestId: reqId,
    });

    if (result.success) {
      res.status(200).json(result);
    } else {
      res.status(400).json(result);
    }

  } catch (error: any) {
    logger.error(`[Flutterwave Controller] createVirtualAccount exception | error=${error.message} | reqId=${reqId}`);
    res.status(500).json({
      success: false,
      message: "An internal server error occurred while creating virtual account.",
    });
  }
};

export const initializePayment = async (req: Request, res: Response, next: NextFunction) => {
  const reqId = req.requestId;
  logger.info(`[Flutterwave Controller] Received initializePayment request | reqId=${reqId}`);

  try {
    const validationResult = initializePaymentSchema.safeParse(req.body);
    if (!validationResult.success) {
      const errorMsg = validationResult.error.issues.map((e: z.ZodIssue) => e.message).join(", ");
      logger.warn(`[Flutterwave Controller] Validation failed | errors=${errorMsg} | reqId=${reqId}`);
      res.status(400).json({
        success: false,
        message: `Validation Error: ${errorMsg}`,
      });
      return;
    }

    const { amount, currency, email, name, userId, redirectUrl, phone } = validationResult.data;
    const tx_ref = `flw-tx-${userId}-${Date.now()}`;

    const client = getFlutterwaveClient();
    const response = await client.request("post", "/payments", {
      tx_ref,
      amount,
      currency,
      redirect_url: redirectUrl,
      customer: {
        email,
        name,
        phone_number: phone,
      },
      customizations: {
        title: "E-Tech Global Wallet Fund",
        description: "Wallet Provisioning Settlement Link",
        logo: "https://i.ibb.co/WWjZrtC7/E-Tech.png",
      },
      meta: {
        userId,
      },
    });

    if (response && response.status === "success" && response.data) {
      res.status(200).json({
        success: true,
        paymentLink: response.data.link,
        reference: tx_ref,
      });
    } else {
      res.status(400).json({
        success: false,
        reference: tx_ref,
        message: response.message || "Failed to initialize payment.",
      });
    }
  } catch (error: any) {
    logger.error(`[Flutterwave Controller] initializePayment exception | error=${error.message} | reqId=${reqId}`);
    res.status(500).json({
      success: false,
      message: "An internal server error occurred while initializing payment.",
    });
  }
};

export const verifyTransfer = async (req: Request, res: Response, next: NextFunction) => {
  const reqId = req.requestId;
  logger.info(`[Flutterwave Controller] Received verifyTransfer request | reqId=${reqId}`);

  try {
    const { reference } = req.body;
    if (!reference) {
      res.status(400).json({
        success: false,
        message: "reference is required.",
      });
      return;
    }

    const client = getFlutterwaveClient();
    const response = await client.request("get", `/transfers?reference=${reference}`);

    if (response && response.status === "success" && Array.isArray(response.data)) {
      res.status(200).json({
        success: true,
        data: response.data,
      });
    } else {
      res.status(404).json({
        success: false,
        message: "No transfer found with this reference.",
      });
    }
  } catch (error: any) {
    logger.error(`[Flutterwave Controller] verifyTransfer exception | error=${error.message} | reqId=${reqId}`);
    res.status(500).json({
      success: false,
      message: "An internal server error occurred while verifying transfer.",
    });
  }
};

export const verifyPayment = async (req: Request, res: Response, next: NextFunction) => {
  const reqId = req.requestId;
  logger.info(`[Flutterwave Controller] Received verifyPayment request | reqId=${reqId}`);

  try {
    const validationResult = verifyPaymentSchema.safeParse(req.body);
    if (!validationResult.success) {
      const errorMsg = validationResult.error.issues.map((e: z.ZodIssue) => e.message).join(", ");
      logger.warn(`[Flutterwave Controller] Verify Payment validation failed | errors=${errorMsg} | reqId=${reqId}`);
      res.status(400).json({
        success: false,
        message: `Validation Error: ${errorMsg}`,
      });
      return;
    }

    const { transaction_id } = validationResult.data;

    const result = await PaymentVerificationService.verifyTransaction({
      transaction_id,
      requestId: reqId,
    });

    if (result.success) {
      res.status(200).json(result);
    } else {
      res.status(400).json(result);
    }

  } catch (error: any) {
    logger.error(`[Flutterwave Controller] verifyPayment exception | error=${error.message} | reqId=${reqId}`);
    res.status(500).json({
      success: false,
      message: "An internal server error occurred while verifying payment.",
    });
  }
};

export const handleWebhook = async (req: Request, res: Response, next: NextFunction) => {
  const reqId = req.requestId;
  logger.info(`[Flutterwave Controller] Received Webhook request | reqId=${reqId}`);

  try {
    const signature = req.headers["verif-hash"] as string || "";

    // Utilize 100% exact rawBody buffer string for HMAC validation if populated
    const rawBodyString = req.rawBody ? req.rawBody.toString("utf8") : JSON.stringify(req.body);

    const client = getFlutterwaveClient();

    // 1. Signature validation
    const isValidSignature = client.verifyWebhookSignature(signature, rawBodyString);
    if (!isValidSignature) {
      logger.warn(`[Flutterwave Controller] Unauthorized Webhook Signature received | reqId=${reqId}`);
      res.status(401).json({
        success: false,
        message: "Unauthorized signature hash mismatch.",
      });
      return;
    }

    const payload = req.body;
    logger.info(`[Flutterwave Controller] Webhook signature verified successfully | event=${payload.event || payload["event.type"]} | reqId=${reqId}`);

    // 2. Validate Event Type
    const eventType = payload.event || payload["event.type"];
    if (eventType !== "charge.completed") {
      logger.info(`[Flutterwave Controller] Ignoring non-charge event: ${eventType} | reqId=${reqId}`);
      res.status(200).json({
        success: true,
        message: "Webhook event ignored gracefully.",
      });
      return;
    }

    // 3. Duplicate Webhook Protection (Firestore-backed)
    const transactionId = payload.data?.id?.toString() || payload.data?.tx_ref;
    if (!transactionId) {
      logger.warn(`[Flutterwave Controller] Webhook payload missing transaction identifier | reqId=${reqId}`);
      res.status(400).json({
        success: false,
        message: "Invalid webhook payload structure.",
      });
      return;
    }

    const idempotency = FirestoreIdempotency.getInstance();
    const isDuplicate = await idempotency.isWebhookDuplicate(transactionId);
    if (isDuplicate) {
      logger.warn(`[Flutterwave Controller] Webhook already processed (Duplicate protection) | transactionId=${transactionId} | reqId=${reqId}`);
      res.status(200).json({
        success: true,
        message: "Webhook already processed successfully.",
      });
      return;
    }

    // Mark as processed in Firestore and memory immediately
    await idempotency.saveWebhookProcessed(transactionId, eventType);

    logger.info(
      `[Flutterwave Controller] Webhook processed successfully | transactionId=${transactionId} | ref=${payload.data?.tx_ref} | reqId=${reqId}`
    );

    res.status(200).json({
      success: true,
      message: "Webhook payload verified and captured.",
    });

  } catch (error: any) {
    logger.error(`[Flutterwave Controller] handleWebhook exception | error=${error.message} | reqId=${reqId}`);
    res.status(500).json({
      success: false,
      message: "An internal server error occurred while handling webhook.",
    });
  }
};

export const initiateBulkTransfer = async (req: Request, res: Response, next: NextFunction) => {
  const reqId = req.requestId;
  logger.info(`[Flutterwave Controller] Received initiateBulkTransfer request | reqId=${reqId}`);

  try {
    const { title, bulk_data } = req.body;
    if (!bulk_data || !Array.isArray(bulk_data)) {
      res.status(400).json({
        success: false,
        message: "Invalid payload: bulk_data must be an array.",
      });
      return;
    }

    const client = getFlutterwaveClient();
    const response = await client.request("post", "/bulk-transfers", {
      title: title || "Bulk Settlement",
      bulk_data,
    });

    if (response && response.status === "success" && response.data) {
      res.status(200).json({
        success: true,
        data: response.data,
      });
    } else {
      res.status(400).json({
        success: false,
        message: response.message || "Bulk transfer dispatch failed.",
      });
    }
  } catch (error: any) {
    logger.error(`[Flutterwave Controller] initiateBulkTransfer exception | error=${error.message} | reqId=${reqId}`);
    res.status(500).json({
      success: false,
      message: "An internal server error occurred while processing bulk transfer.",
    });
  }
};

export const proxy = async (req: Request, res: Response, next: NextFunction) => {
  const reqId = req.requestId;
  logger.info(`[Flutterwave Controller] Received proxy request | reqId=${reqId}`);

  try {
    const { method, endpoint, body } = req.body;
    if (!endpoint) {
      res.status(400).json({
        success: false,
        message: "endpoint is required.",
      });
      return;
    }

    let targetUrl = endpoint;
    if (!targetUrl.startsWith("/")) {
      targetUrl = "/" + targetUrl;
    }

    const client = getFlutterwaveClient();
    const response = await client.request(
      (method || "get").toLowerCase() as any,
      targetUrl,
      body || undefined
    );

    res.status(200).json(response);
  } catch (error: any) {
    logger.error(`[Flutterwave Controller] proxy exception | error=${error.message} | reqId=${reqId}`);
    res.status(500).json({
      success: false,
      message: error.message || "An internal error occurred during proxy request.",
    });
  }
};

export const getBanks = async (req: Request, res: Response, next: NextFunction) => {
  const reqId = req.requestId;
  logger.info(`[Flutterwave Controller] Received getBanks request | reqId=${reqId}`);

  try {
    const client = getFlutterwaveClient();
    const response = await client.request("get", "/banks/NG");

    res.status(200).json(response);
  } catch (error: any) {
    logger.error(`[Flutterwave Controller] getBanks exception | error=${error.message} | reqId=${reqId}`);
    res.status(500).json({
      success: false,
      message: "An internal server error occurred while fetching banks.",
    });
  }
};

export const charge = async (req: Request, res: Response, next: NextFunction) => {
  const reqId = req.requestId;
  logger.info(`[Flutterwave Controller] Received charge request | reqId=${reqId}`);

  try {
    const { type } = req.query;
    const client = getFlutterwaveClient();
    const response = await client.request("post", `/charges?type=${type}`, req.body);

    res.status(200).json(response);
  } catch (error: any) {
    logger.error(`[Flutterwave Controller] charge exception | error=${error.message} | reqId=${reqId}`);
    res.status(500).json({
      success: false,
      message: "An internal server error occurred while processing charge.",
    });
  }
};

export const payBill = async (req: Request, res: Response, next: NextFunction) => {
  const reqId = req.requestId;
  logger.info(`[Flutterwave Controller] Received payBill request | reqId=${reqId}`);

  try {
    const { country, customer, amount, recurrence, type, reference } = req.body;
    if (!customer || !amount || !type || !reference) {
      res.status(400).json({
        success: false,
        message: "Invalid payload: customer, amount, type, and reference are required.",
      });
      return;
    }

    const client = getFlutterwaveClient();
    const response = await client.request("post", "/bills", {
      country: country || "NG",
      customer,
      amount,
      recurrence: recurrence || "ONCE",
      type,
      reference,
    });

    if (response && response.status === "success" && response.data) {
      res.status(200).json({
        success: true,
        data: response.data,
      });
    } else {
      res.status(400).json({
        success: false,
        message: response.message || "Bill payment failed on provider rail.",
      });
    }
  } catch (error: any) {
    logger.error(`[Flutterwave Controller] payBill exception | error=${error.message} | reqId=${reqId}`);
    res.status(500).json({
      success: false,
      message: "An internal server error occurred while processing bill payment.",
    });
  }
};
