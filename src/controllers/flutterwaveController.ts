import { env } from "../config/env";
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

export const BANK_CODE_MAPPING: Record<string, string> = {
  // Major Banks
  '1': '044',    // Access Bank
  '2': '023',    // Citi Bank
  '4': '050',    // EcoBank
  '5': '011',    // First Bank
  '6': '214',    // FCMB
  '7': '070',    // Fidelity Bank
  '8': '058',    // GTBank
  '9': '076',    // Polaris Bank
  '10': '221',   // Stanbic IBTC
  '11': '068',   // Standard Chartered
  '12': '232',   // Sterling Bank
  '13': '033',   // UBA
  '14': '032',   // Union Bank
  '15': '035',   // Wema Bank
  '16': '057',   // Zenith Bank
  '17': '215',   // Unity Bank
  '18': '101',   // Providus Bank
  '183': '082',  // Keystone Bank
  '184': '301',  // Jaiz Bank
  '231': '100',  // Suntrust Bank
  '259': '400001', // FSDH Merchant Bank
  '260': '502',  // Rand Merchant Bank
  
  // Payment Service Providers
  '1435': '100004', // Opay
  '990': '100033',  // Palmpay
  '254': '090267',  // Kuda Bank
  '1864': '090405', // Moniepoint
  '639': '090328',  // Eyowo
  '1434': '100034', // Zenith Eazy Wallet
  '1431': '100052', // Beta-Access Yello
  '1430': '110003', // Interswitch
  '1429': '110005', // 3Line
  '1428': '110006', // Paystack
  '1427': '110008', // Kadick
  '1426': '110010', // Interswitch Financial Inclusion
  '1425': '110011', // Arca Payments
  '1424': '110012', // Cellulant
  '1423': '110013', // QR Payments
  '1422': '110015', // Vas2Nets
  '1421': '110017', // Crowdforce
  '1420': '110018', // Microsystems
  '1419': '110019', // Nibssussd
  '1418': '110021', // Bud Infrastructure
  '1417': '110022', // Koraypay
  '1416': '110023', // Capricorn Digital
  '1415': '110024', // Resident Fintech
  '1414': '110025', // Netapps
  '1413': '110026', // Spay Business
  '1412': '110027', // Yello Digital
  '1411': '110028', // Nomba
  '1410': '110029', // Woven Finance
  '1409': '120002', // HopePSB
  '1408': '120003', // Momo PSB
  '1407': '120004', // Smartcash PSB
  '1406': '120005', // Money Master PSB
  
  // Microfinance Banks
  '997': '120001', // 9 Payment Service Bank
  '996': '090286', // Safe Haven
  '995': '100035', // M36
  '994': '090420', // Letshego
  '992': '090383', // Manny
  '989': '090366', // Firmus
  '988': '000030', // Parallex Bank
  '987': '060004', // Greenwich Merchant Bank
  '986': '090423', // MAUTECH
  '965': '303',    // ChamsMobile
  '964': '000025', // Titan Trust Bank
  '949': '100007', // Stanbic IBTC @ease
  '948': '100006', // eTranzact
  '947': '100005', // Cellulant
  '946': '100003', // Parkway-ReadyCash
  '945': '100001', // FET
  
  // Virtual Banks
  '1353': '090435', // Links Microfinance
  '1317': '090470', // Dot Microfinance
  '1154': '090482', // Clearpay
};


// Zod Schemas
const resolveAccountSchema = z.object({
  account_number: z.string().regex(/^\d+$/, "Account number must contain only digits").min(5, "Account number is too short").max(15, "Account number is too long"),
  bank_code: z.string().regex(/^\d+$/, "Bank code must contain only digits").min(3, "Bank code is too short").max(10, "Bank code is too long"),
});

const transferSchema = z.object({
  amount: z.number().positive("Amount must be greater than zero"),
  account_number: z.string().regex(/^\d+$/, "Account number must contain only digits").min(5, "Account number is too short").max(15, "Account number is too long"),
  account_bank: z.string().regex(/^\d+$/, "Bank code must contain only digits").min(3, "Bank code is too short").max(10, "Bank code is too long"),
  beneficiary_name: z.string().min(2, "Beneficiary name is required"),
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
    const rawBankCode = req.body.bank_code ?? req.body.bankCode ?? req.body.account_bank ?? req.body.accountBank ?? req.body.bankId;
    let mappedBankCode = rawBankCode;
    if (rawBankCode && BANK_CODE_MAPPING[String(rawBankCode).trim()]) {
      mappedBankCode = BANK_CODE_MAPPING[String(rawBankCode).trim()];
    }
    const body = {
      account_number: req.body.account_number ?? req.body.accountNumber,
      bank_code: mappedBankCode,
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
  logger.info(`[Flutterwave Controller] Received initiateTransfer request | reqId=${reqId} | body:`, req.body);

  try {
    const body = {
      amount: typeof req.body.amount === "string" ? Number(req.body.amount) : req.body.amount,
      account_number: req.body.account_number ?? req.body.accountNumber,
      account_bank: req.body.account_bank ?? req.body.accountBank ?? req.body.bank_code ?? req.body.bankCode,
      beneficiary_name: req.body.beneficiary_name ?? req.body.beneficiaryName ?? req.body.account_name ?? req.body.accountName ?? req.body.recipientName,
      currency: req.body.currency || "NGN",
      narration: req.body.narration || `Transfer of ${req.body.amount}`,
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
    const keyPrefix = env.FLW_SECRET_KEY ? env.FLW_SECRET_KEY.slice(0, 12) : "MISSING";
    logger.info(`[Flutterwave Controller] Sending to Flutterwave (Transfer Payload). Key prefix: ${keyPrefix} | Payload:`, payload);

    const result = await transferService.executeTransfer({
      amount: payload.amount,
      account_number: payload.account_number,
      bank_code: payload.account_bank,
      account_name: payload.beneficiary_name,
      currency: payload.currency,
      narration: payload.narration,
      reference: payload.reference,
      requestId: reqId,
      userId: req.body.userId || "N/A",
    });

    logger.info("Flutterwave transfer response:", result);

    if (result.success) {
      res.status(200).json({
        success: true,
        processing: result.processing ?? (result.status === "pending"),
        message: result.processing
          ? "Transfer submitted successfully and is being processed."
          : (result.message || "Transfer initiated successfully."),
        reference: result.reference,
        provider_reference: result.provider_reference,
        status: result.status,
        flutterwaveStatus: result.flutterwaveStatus || "new",
      });
    } else {
      res.status(400).json({
        success: false,
        reference: result.reference,
        message: result.message || "Failed to process outward transfer.",
      });
    }

  } catch (error: any) {
    logger.error(`[Flutterwave Controller] initiateTransfer exception | error=${error.message || error} | reqId=${reqId}`);
    res.status(500).json({
      success: false,
      message: error.message || "An internal server error occurred while processing transfer.",
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
      try {
        const accountDoc = await adminDb.collection("wallet_accounts").doc(userId).get();
        if (accountDoc.exists) {
          const accountData = accountDoc.data();
          const userDoc = await adminDb.collection("users").doc(userId).get();
          const userData = userDoc.exists ? userDoc.data() : {};

          logger.info(`[Payment Gateway] Permanent virtual account already exists for user: ${userId}. Skipping duplicate creation.`);

          const finalResponse = {
            success: true,
            status: "success",
            alreadyExists: true,
            isExisting: true,
            is_existing: true,
            accountNumber: accountData?.accountNumber,
            account_number: accountData?.accountNumber,
            accountName: accountData?.accountName,
            account_name: accountData?.accountName,
            bankName: accountData?.bankName || "Wema Bank",
            bank_name: accountData?.bankName || "Wema Bank",
            bankCode: accountData?.bankCode || "035",
            bank_code: accountData?.bankCode || "035",
            reference: accountData?.txRef || accountData?.flwRef,
            kycStatus: userData?.kycStatus || "VERIFIED",
            bvn: userData?.bvn || null,
            nin: userData?.nin || null,
            data: {
              account_number: accountData?.accountNumber,
              account_name: accountData?.accountName,
              bank_name: accountData?.bankName || "Wema Bank",
              bank_code: accountData?.bankCode || "035",
              reference: accountData?.txRef || accountData?.flwRef,
              is_existing: true,
              kycStatus: userData?.kycStatus || "VERIFIED",
              bvn: userData?.bvn || null,
              nin: userData?.nin || null,
            }
          };

          logger.info(`[USSD Virtual Account Audit]`, {
            firestoreDocumentPath: `wallet_accounts/${userId}`,
            userUid: userId,
            accountNumber: accountData?.accountNumber,
            accountName: accountData?.accountName,
            bankName: accountData?.bankName || "Wema Bank",
            isExisting: true,
            finalJsonReturned: finalResponse,
          });

          res.status(200).json(finalResponse);
          return;
        }
      } catch (readErr: any) {
        logger.error(`[Payment Gateway] Error reading existing virtual account document from Firestore: ${readErr.message}`);
        res.status(400).json({
          success: false,
          message: `Unable to read existing virtual account: ${readErr.message}`,
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
      let kycStatus = "VERIFIED";
      let bvnVal = null;
      let ninVal = null;

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
        bvnVal = isBvn ? bvn : null;
        ninVal = !isBvn ? bvn : null;

        await adminDb.collection("users").doc(userId).set({
          kycStatus: "VERIFIED",
          bvn: bvnVal,
          nin: ninVal,
        }, { merge: true });

        logger.info(`[Payment Gateway] Successfully recorded verified KYC & Account details for user: ${userId}`);
      }

      const finalResponse = {
        success: true,
        status: "success",
        alreadyExists: false,
        isExisting: false,
        is_existing: false,
        accountNumber: result.account_number,
        account_number: result.account_number,
        accountName: result.account_name,
        account_name: result.account_name,
        bankName: result.bank_name || "Wema Bank",
        bank_name: result.bank_name || "Wema Bank",
        bankCode: "035",
        bank_code: "035",
        currency: result.currency || "NGN",
        reference: result.reference,
        kycStatus: kycStatus,
        bvn: bvnVal,
        nin: ninVal,
        data: {
          account_number: result.account_number,
          account_name: result.account_name,
          bank_name: result.bank_name || "Wema Bank",
          bank_code: "035",
          reference: result.reference,
          is_existing: false,
          kycStatus: kycStatus,
          bvn: bvnVal,
          nin: ninVal,
        }
      };

      logger.info(`[USSD Virtual Account Audit]`, {
        firestoreDocumentPath: userId ? `wallet_accounts/${userId}` : "N/A",
        userUid: userId || "N/A",
        accountNumber: result.account_number,
        accountName: result.account_name,
        bankName: result.bank_name || "Wema Bank",
        isExisting: false,
        finalJsonReturned: finalResponse,
      });

      res.status(200).json(finalResponse);
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
    if (eventType !== "charge.completed" && eventType !== "transfer.completed") {
      logger.info(`[Flutterwave Controller] Ignoring non-charge/transfer event: ${eventType} | reqId=${reqId}`);
      res.status(200).json({
        success: true,
        message: "Webhook event ignored gracefully.",
      });
      return;
    }

    // 3. Duplicate Webhook Protection (Firestore-backed)
    const transactionId = payload.data?.id?.toString() || payload.data?.tx_ref || payload.data?.reference;
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

    // If it's a transfer completion, update Firestore transfer status
    if (eventType === "transfer.completed") {
      const reference = payload.data?.reference || payload.data?.tx_ref;
      const flwStatus = payload.data?.status?.toLowerCase();
      const flwId = payload.data?.id?.toString();

      logger.info(
        `[Flutterwave Controller Webhook] Processing transfer.completed | reference=${reference} | flwId=${flwId} | status=${flwStatus} | reqId=${reqId}`
      );

      const dbStatus = (flwStatus === "successful" || flwStatus === "success")
        ? "success"
        : (flwStatus === "failed" ? "failed" : "pending");

      if (reference) {
        if (typeof (idempotency as any).saveReference === "function") {
          await (idempotency as any).saveReference(reference, "flutterwave", dbStatus, flwId);
        }

        if (adminDb) {
          try {
            await adminDb.collection("transfers").doc(reference).set({
              flutterwaveTransferId: flwId || null,
              flutterwaveStatus: flwStatus,
              updatedAt: new Date().toISOString(),
            }, { merge: true });
            logger.info(`[Flutterwave Controller Webhook] Updated transfer status in Firestore for reference: ${reference}`);
          } catch (fsErr: any) {
            logger.error(`[Flutterwave Controller Webhook] Firestore transfer update failed for reference: ${reference} | error=${fsErr.message}`);
          }
        }
      }
    }

    logger.info(
      `[Flutterwave Controller] Webhook processed successfully | transactionId=${transactionId} | ref=${payload.data?.tx_ref || payload.data?.reference} | reqId=${reqId}`
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

const USSD_BANK_PREFIXES: Record<string, string> = {
  "058": "*737*", // GTBank
  "011": "*894*", // First Bank
  "057": "*966*", // Zenith Bank
  "033": "*919*", // UBA
  "044": "*901*", // Access Bank
  "035": "*329*", // Wema Bank
  "070": "*7111*", // Fidelity Bank
  "030": "*909*", // Heritage Bank
  "032": "*826*", // Union Bank
  "050": "*822*", // FCMB
  "082": "*711*", // Keystone Bank
  "214": "*565*0*", // FCMB/other
  "076": "*770*", // Polaris Bank
  "232": "*945*", // Sterling Bank
  "035a": "*322*", // ALAT (Wema)
  "101": "*901*", // Providus Bank
  "215": "*737*", // Unity Bank
  "301": "*565*", // Jaiz Bank
  "084": "*833*", // Enterprise Bank
  "100": "*779*", // Suntrust Bank
  "999992": "*955*", // OPay
  "50515": "*5573*", // PalmPay
};

export const charge = async (req: Request, res: Response, next: NextFunction) => {
  const reqId = req.requestId;
  logger.info(`[Flutterwave Controller] Received charge request | reqId=${reqId}`);

  try {
    const { type } = req.query;
    const client = getFlutterwaveClient();
    const response = await client.request("post", `/charges?type=${type}`, req.body);

    logger.info(`[Flutterwave Controller] Raw charge response:`, response);

    // If it's a USSD charge request, verify and normalize the generated USSD code/prefix
    if (type === "ussd" && response && response.status === "success" && (response.meta?.authorization || response.data?.authorization)) {
      const auth = response.meta?.authorization || response.data?.authorization;
      const rawUssd = auth.note || auth.validate_instructions || auth.instruction || "";

      const rawBankCode = req.body.account_bank || req.body.accountBank || req.body.bankId || req.body.bank_code || req.body.bankCode;
      let bankCode = rawBankCode;
      if (rawBankCode && BANK_CODE_MAPPING[String(rawBankCode).trim()]) {
        bankCode = BANK_CODE_MAPPING[String(rawBankCode).trim()];
      }
      let bankName = "Selected Bank";
      if (bankCode && adminDb) {
        const bankDoc = await adminDb.collection("banks").doc(bankCode).get();
        if (bankDoc.exists) {
          bankName = bankDoc.data()?.name || "Selected Bank";
        }
      }

      const prefix = USSD_BANK_PREFIXES[bankCode] || "*955*";

      let finalUssd = rawUssd;
      if (rawUssd.includes("bank_ussd_code")) {
        finalUssd = rawUssd.replace(/\*?bank_ussd_code\*?/g, prefix);
      }

      logger.info(`[USSD Charge Audit]`, {
        bankCode,
        bankName,
        ussdPrefix: prefix,
        rawAuthorizationNote: rawUssd,
        finalUssdString: finalUssd,
      });

      // Update the authorization note in the response object
      if (auth.note) auth.note = finalUssd;
      if (auth.validate_instructions) auth.validate_instructions = finalUssd;
      if (auth.instruction) auth.instruction = finalUssd;
    }

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

export const getTransferStatus = async (req: Request, res: Response, next: NextFunction) => {
  const reqId = req.requestId;
  const { reference } = req.params;
  logger.info(`[Flutterwave Controller] Received getTransferStatus request | reference=${reference} | reqId=${reqId}`);

  if (!reference) {
    res.status(400).json({
      success: false,
      message: "Transfer reference parameter is required.",
    });
    return;
  }

  try {
    let flwStatus: string | undefined;
    let providerRef: string | undefined;

    // 1. Check transfers collection
    if (adminDb) {
      try {
        const doc = await adminDb.collection("transfers").doc(reference).get();
        if (doc.exists) {
          const data = doc.data();
          flwStatus = data?.flutterwaveStatus;
          providerRef = data?.flutterwaveTransferId;
          logger.info(`[Flutterwave Controller] Found transfer status in transfers collection | status=${flwStatus} | reference=${reference} | reqId=${reqId}`);
        }
      } catch (fsErr: any) {
        logger.error(`[Flutterwave Controller] Firestore read transfers failed: ${fsErr.message}`);
      }
    }

    // 2. Check gateway_idempotency_references if not found or status missing
    if (!flwStatus && adminDb) {
      try {
        const doc = await adminDb.collection("gateway_idempotency_references").doc(reference).get();
        if (doc.exists) {
          const data = doc.data();
          const dbStatus = data?.status; // 'success', 'pending', 'failed'
          providerRef = data?.provider_reference;
          flwStatus = dbStatus === "success" ? "successful" : (dbStatus === "failed" ? "failed" : "pending");
          logger.info(`[Flutterwave Controller] Found status in gateway_idempotency_references | status=${flwStatus} | reference=${reference} | reqId=${reqId}`);
        }
      } catch (fsErr: any) {
        logger.error(`[Flutterwave Controller] Firestore read idempotency failed: ${fsErr.message}`);
      }
    }

    // 3. Fallback: query Flutterwave directly by reference
    if (!flwStatus) {
      try {
        logger.info(`[Flutterwave Controller] Transfer status not found in DB. Querying Flutterwave directly | reference=${reference} | reqId=${reqId}`);
        const client = getFlutterwaveClient();
        const response = await client.request("get", `/transfers?reference=${reference}`);

        logger.info(`[Flutterwave Controller] Flutterwave query by reference response: ${JSON.stringify(response)}`);

        if (response && response.status === "success" && Array.isArray(response.data) && response.data.length > 0) {
          const trans = response.data[0];
          flwStatus = trans.status?.toLowerCase();
          providerRef = trans.id?.toString();

          // Sync back to Firestore transfers collection for faster future lookups
          if (adminDb) {
            await adminDb.collection("transfers").doc(reference).set({
              transferReference: reference,
              flutterwaveTransferId: providerRef || null,
              flutterwaveStatus: flwStatus || "pending",
              updatedAt: new Date().toISOString(),
            }, { merge: true });
          }
        }
      } catch (flwErr: any) {
        logger.error(`[Flutterwave Controller] Direct Flutterwave query failed: ${flwErr.message}`);
      }
    }

    // Map flutterwave status to standardized: NEW, PENDING, SUCCESS, FAILED
    let mappedStatus = "PENDING";
    if (flwStatus) {
      const lower = flwStatus.toLowerCase();
      if (lower === "new") {
        mappedStatus = "NEW";
      } else if (lower === "successful" || lower === "success" || lower === "completed" || lower === "closed") {
        mappedStatus = "SUCCESS";
      } else if (lower === "failed" || lower === "error" || lower === "reversed") {
        mappedStatus = "FAILED";
      } else if (lower === "pending" || lower === "processing" || lower === "queued") {
        mappedStatus = "PENDING";
      }
    }

    logger.info(`[Flutterwave Controller] GET /transfer/status/:reference final result | reference=${reference} | mappedStatus=${mappedStatus} | reqId=${reqId}`);

    res.status(200).json({
      success: true,
      status: mappedStatus,
    });

  } catch (error: any) {
    logger.error(`[Flutterwave Controller] getTransferStatus exception | error=${error.message} | reqId=${reqId}`);
    res.status(500).json({
      success: false,
      message: "An internal server error occurred while retrieving transfer status.",
    });
  }
};
