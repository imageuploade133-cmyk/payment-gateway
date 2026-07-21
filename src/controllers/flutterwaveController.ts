import { Request, Response, NextFunction } from "express";
import { z } from "zod";
import logger from "../config/logger";
import { AccountResolutionService } from "../services/accountResolutionService";
import { TransferService } from "../services/transferService";
import { PaymentVerificationService } from "../services/paymentVerificationService";
import { getFlutterwaveClient } from "../providers/flutterwave";
import { FirestoreIdempotency } from "../services/firestoreIdempotency";
import { adminDb } from "../config/firebase";
import { AuthenticatedRequest } from "../middleware/auth";

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

export const getTransferFee = async (req: Request, res: Response, next: NextFunction) => {
  const reqId = req.requestId;
  logger.info(`[Flutterwave Controller] Received getTransferFee request | reqId=${reqId}`);
  logger.info("Transfer fee incoming query params:", req.query);

  try {
    const amountStr = req.query.amount as string;
    const currencyStr = (req.query.currency as string) || "NGN";

    if (!amountStr || isNaN(Number(amountStr)) || Number(amountStr) <= 0) {
      res.status(400).json({
        success: false,
        message: "Validation Error: A valid positive numeric amount query parameter is required.",
      });
      return;
    }

    const amount = Number(amountStr);
    logger.info("Transfer fee normalized parameters:", { amount, currency: currencyStr });

    const client = getFlutterwaveClient();

    logger.info(`Sending to Flutterwave (Transfer Fee Request): amount=${amount}&currency=${currencyStr}`);
    const response = await client.request("get", `/transfers/fee?amount=${amount}&currency=${currencyStr}`);
    logger.info("Flutterwave transfer fee response:", response);

    if (response && response.status === "success" && Array.isArray(response.data)) {
      const feeItem = response.data[0];
      const fee = Number(feeItem.fee) || 0;
      const totalDebit = amount + fee;

      res.status(200).json({
        success: true,
        fee,
        totalDebit,
        currency: currencyStr,
      });
    } else {
      res.status(400).json({
        success: false,
        message: response.message || "Failed to retrieve transfer fee from provider.",
      });
    }

  } catch (error: any) {
    logger.error(`[Flutterwave Controller] getTransferFee exception | error=${error.message} | reqId=${reqId}`);
    res.status(500).json({
      success: false,
      message: "An internal server error occurred while retrieving transfer fee.",
    });
  }
};

export const initiateTransfer = async (req: Request, res: Response, next: NextFunction) => {
  const reqId = req.requestId;
  logger.info(`[Flutterwave Controller] Received initiateTransfer request | reqId=${reqId}`);
  logger.info("Transfer incoming request body:", req.body);

  try {
    const body = {
      amount: typeof req.body.amount === "string" ? Number(req.body.amount) : req.body.amount,
      account_number: req.body.account_number ?? req.body.accountNumber,
      bank_code: req.body.bank_code ?? req.body.bankCode ?? req.body.account_bank ?? req.body.accountBank,
      account_name: req.body.account_name ?? req.body.accountName,
      currency: req.body.currency,
      narration: req.body.narration,
      reference: req.body.reference,
    };
    logger.info("Transfer normalized body:", body);

    const validationResult = transferSchema.safeParse(body);
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
    logger.info("Sending to Flutterwave (Transfer Payload):", payload);

    const result = await transferService.executeTransfer({
      ...payload,
      requestId: reqId,
    });

    logger.info("Flutterwave transfer response:", result);

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

export const getKycStatus = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const reqId = req.requestId;
  logger.info(`[Flutterwave Controller] Received getKycStatus request | reqId=${reqId}`);

  try {
    const userId = (req.query.userId as string) || (req.body.userId as string) || req.user?.uid;
    if (!userId || typeof userId !== "string" || userId.trim() === "") {
      res.status(400).json({
        success: false,
        message: "userId query parameter or request body is required.",
      });
      return;
    }

    if (!adminDb) {
      res.status(503).json({
        success: false,
        message: "Database service is temporarily unavailable.",
      });
      return;
    }

    logger.info(`[Flutterwave Controller] Reading KYC status and permanent account for user: ${userId}`);

    const userDoc = await adminDb.collection("users").doc(userId).get();
    const userData = userDoc.exists ? userDoc.data() : {};

    const accountDoc = await adminDb.collection("wallet_accounts").doc(userId).get();
    const accountData = accountDoc.exists ? accountDoc.data() : null;

    res.status(200).json({
      success: true,
      userId,
      kycStatus: userData?.kycStatus || "PENDING",
      bvn: userData?.bvn || null,
      nin: userData?.nin || null,
      account: accountData ? {
        bankName: accountData.bankName,
        accountNumber: accountData.accountNumber,
        accountName: accountData.accountName,
        currency: accountData.currency || "NGN",
      } : null,
    });

  } catch (error: any) {
    logger.error(`[Flutterwave Controller] getKycStatus exception | error=${error.message} | reqId=${reqId}`);
    res.status(500).json({
      success: false,
      message: "An internal server error occurred while retrieving KYC status.",
    });
  }
};

export const createVirtualAccount = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const reqId = req.requestId;
  logger.info(`[Flutterwave Controller] Received createVirtualAccount request | reqId=${reqId}`);
  logger.info("Create Virtual Account incoming request body:", req.body);

  try {
    const userId = req.body.userId ?? req.body.uid ?? req.user?.uid;

    // 1. Guard: Check if the permanent virtual account already exists in Firebase
    if (userId && adminDb) {
      const accountDoc = await adminDb.collection("wallet_accounts").doc(userId).get();
      if (accountDoc.exists) {
        const accountData = accountDoc.data();
        const userDoc = await adminDb.collection("users").doc(userId).get();
        const userData = userDoc.exists ? userDoc.data() : {};

        logger.info(`[Payment Gateway] Permanent virtual account already exists for user: ${userId}. Skipping duplicate creation.`);
        res.status(200).json({
          success: true,
          alreadyExists: true,
          bank_name: accountData?.bankName || "Wema Bank",
          account_number: accountData?.accountNumber,
          account_name: accountData?.accountName,
          currency: accountData?.currency || "NGN",
          reference: accountData?.txRef || accountData?.flwRef,
          kycStatus: userData?.kycStatus || "VERIFIED",
          bvn: userData?.bvn || null,
          nin: userData?.nin || null,
        });
        return;
      }
    }

    const body = {
      email: req.body.email,
      is_permanent: req.body.is_permanent ?? req.body.isPermanent,
      bvn: req.body.bvn,
      tx_ref: req.body.tx_ref ?? req.body.txRef,
      phonenumber: req.body.phonenumber ?? req.body.phoneNumber ?? req.body.phone,
      firstname: req.body.firstname ?? req.body.firstName,
      lastname: req.body.lastname ?? req.body.lastName,
    };
    logger.info("Create Virtual Account normalized body:", body);

    const validationResult = createVirtualAccountSchema.safeParse(body);
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
    logger.info("Sending to Flutterwave (Virtual Account Payload):", payload);

    const result = await PaymentVerificationService.createVirtualAccount({
      ...payload,
      bvn: payload.bvn || "",
      requestId: reqId,
    });

    logger.info("Flutterwave virtual account response:", result);

    if (result.success) {
      // 2. Persist dynamic KYC status and account details to Firestore
      if (userId && adminDb) {
        const accountRecord = {
          userId,
          accountNumber: result.account_number,
          bankName: result.bank_name || "Wema Bank",
          accountName: result.account_name,
          currency: result.currency || "NGN",
          flwRef: result.reference,
          txRef: payload.tx_ref,
          isPermanent: true,
          status: "active",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        await adminDb.collection("wallet_accounts").doc(userId).set(accountRecord, { merge: true });

        const bvn = payload.bvn || "";
        const isBvn = bvn && /^\d{11}$/.test(bvn);
        await adminDb.collection("users").doc(userId).set({
          kycStatus: "VERIFIED",
          bvn: isBvn ? bvn : null,
          nin: !isBvn ? bvn : null,
        }, { merge: true });

        // Add verified kyc info into returned response
        (result as any).kycStatus = "VERIFIED";
        (result as any).bvn = isBvn ? bvn : null;
        (result as any).nin = !isBvn ? bvn : null;
        logger.info(`[Payment Gateway] Successfully recorded and returned verified KYC & Account details for user: ${userId}`);
      }

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
