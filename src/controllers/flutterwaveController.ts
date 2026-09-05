import { mapProviderStatus } from "../utils/statusMapper";
import { parseUserIdFromTxRef, resolveFundingLedgerDocId } from "../utils/userIdParser";
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
import { ReconciliationService } from "../services/reconciliationService";
import { BankCacheService } from "../services/bankCacheService";
import { FieldValue } from "firebase-admin/firestore";
import { AuthenticatedRequest } from "../middleware/auth";

const idempotency = FirestoreIdempotency.getInstance();


function maskAccount(num?: string): string | null {
  if (!num) return null;
  const str = String(num).trim();
  if (str.length <= 4) return str;
  return `****${str.slice(-4)}`;
}

async function resolveUserIdFromPayload(data: any, txRef: string): Promise<string | null> {
  if (data?.meta?.userId) {
    return String(data.meta.userId).trim();
  }
  if (data?.meta?.user_id) {
    return String(data.meta.user_id).trim();
  }
  const parsedUid = parseUserIdFromTxRef(txRef);
  if (parsedUid) {
    return parsedUid;
  }
  const email = data?.customer?.email;
  if (email && adminDb) {
    try {
      const snap = await adminDb.collection("users").where("email", "==", email).get();
      if (!snap.empty) {
        return snap.docs[0].id;
      }
    } catch (err: any) {
      logger.error(`[resolveUserIdFromPayload] Email lookup failed for ${email}: ${err.message}`);
    }
  }
  return null;
}

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
  transaction_id: z.string().optional(),
  tx_ref: z.string().optional(),
  txRef: z.string().optional(),
}).refine(data => data.transaction_id || data.tx_ref || data.txRef, {
  message: "Either transaction_id, tx_ref, or txRef must be provided",
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

const createCardSchema = z.object({
  currency: z.enum(["USD", "NGN"]),
  amount: z.number().nonnegative("Amount must be zero or positive"),
  billing_name: z.string().min(2, "Billing name is required"),
  billing_address: z.string().min(2, "Billing address is required"),
  billing_city: z.string().min(2, "Billing city is required"),
  billing_state: z.string().min(2, "Billing state is required"),
  billing_postal_code: z.string().min(2, "Billing postal code is required"),
  billing_country: z.string().min(2, "Billing country is required"),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  date_of_birth: z.string().optional(),
  title: z.string().optional(),
  gender: z.string().optional(),
  callback_url: z.string().optional(),
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

const rateCache: Map<string, { data: any; expiresAt: number }> = new Map();
const RATE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export const getExchangeRates = async (req: Request, res: Response, next: NextFunction) => {
  const reqId = req.requestId;
  logger.info(`[Flutterwave Controller] Received getExchangeRates request | reqId=${reqId}`);

  try {
    let sourceCurrency = (
      (req.query.sourceCurrency as string) ||
      (req.query.source_currency as string) ||
      (req.query.from as string) ||
      "USD"
    ).trim().toUpperCase();

    let destinationCurrency = (
      (req.query.destinationCurrency as string) ||
      (req.query.destination_currency as string) ||
      (req.query.to as string) ||
      "NGN"
    ).trim().toUpperCase();

    if (sourceCurrency === "FCFA") sourceCurrency = "XOF";
    if (destinationCurrency === "FCFA") destinationCurrency = "XOF";

    const amountNum = parseFloat((req.query.amount as string) || "1");
    const amount = isNaN(amountNum) || amountNum <= 0 ? 1 : amountNum;

    const allowed = ["NGN", "USD", "EUR", "GBP", "GHS", "KES", "XOF", "XAF", "CAD", "ZAR", "TZS", "UGX", "RWF", "ZMW"];
    if (!allowed.includes(sourceCurrency) || !allowed.includes(destinationCurrency)) {
      res.status(400).json({
        success: false,
        message: `Invalid currency specified. Supported currencies include: ${allowed.join(", ")}.`,
      });
      return;
    }

    if (sourceCurrency === destinationCurrency) {
      res.status(400).json({
        success: false,
        message: "Source and destination currencies cannot be identical.",
      });
      return;
    }

    const cacheKey = `${sourceCurrency}_${destinationCurrency}_${amount}`;
    const now = Date.now();
    const cached = rateCache.get(cacheKey);

    if (cached && cached.expiresAt > now) {
      logger.info(`[Flutterwave Controller] Returning cached exchange rate for ${cacheKey}`);
      res.status(200).json(cached.data);
      return;
    }

    const client = getFlutterwaveClient();
    logger.info(`Sending to Flutterwave (Transfer Rates): source_currency=${sourceCurrency}&destination_currency=${destinationCurrency}&amount=${amount}`);

    const response = await client.request(
      "get",
      `/transfers/rates?amount=${amount}&destination_currency=${destinationCurrency}&source_currency=${sourceCurrency}`
    );

    logger.info("[Flutterwave Controller] Transfer rate response:", response);

    if (response && response.status === "success" && response.data) {
      const rawRate = Number(response.data.rate);
      if (isNaN(rawRate) || rawRate <= 0) {
        res.status(400).json({
          success: false,
          message: "Invalid exchange rate value returned by Flutterwave provider.",
        });
        return;
      }

      const destinationAmount = Number((amount * rawRate).toFixed(6));

      const responseData = {
        success: true,
        provider: "flutterwave",
        sourceCurrency,
        destinationCurrency,
        rate: rawRate,
        sourceAmount: amount,
        destinationAmount,
        fetchedAt: new Date().toISOString(),
      };

      rateCache.set(cacheKey, { data: responseData, expiresAt: now + RATE_CACHE_TTL_MS });

      res.status(200).json(responseData);
    } else {
      res.status(400).json({
        success: false,
        message: response?.message || "Failed to retrieve transfer rate from Flutterwave provider.",
      });
    }
  } catch (error: any) {
    logger.error(`[Flutterwave Controller] getExchangeRates exception | error=${error.message} | reqId=${reqId}`);
    res.status(500).json({
      success: false,
      message: "An internal server error occurred while retrieving exchange rate.",
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
      const errorMsg = validationResult.error.issues.map((e: any) => e.message).join(", ");
      logger.error("Transfer validation failed", {
        issues: validationResult.error.issues,
        body: req.body,
        normalizedBody: body,
        reqId
      });
      
      validationResult.error.issues.forEach((issue: any) => {
        logger.error(`Validation failed:
Field: ${issue.path.join(".")}
Expected: ${issue.expected || "valid string"}
Received: ${issue.received || "undefined"}`);
      });

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

      fee: typeof req.body.fee === "number"
        ? req.body.fee
        : (req.body.fee ? Number(req.body.fee) : undefined),

      markup: typeof req.body.markup === "number"
        ? req.body.markup
        : (req.body.markup ? Number(req.body.markup) : 0),

      vat: typeof req.body.vat === "number"
        ? req.body.vat
        : (req.body.vat ? Number(req.body.vat) : 0),
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
      tx_ref: req.body.tx_ref ?? req.body.txRef ?? (userId ? `user-wallet-${userId}` : undefined),
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
    const ledgerDocId = resolveFundingLedgerDocId(tx_ref);

    if (adminDb) {
      try {
        await adminDb.collection("transactions").doc(ledgerDocId).set({
          userId,
          amount,
          currency: currency || "NGN",
          reference: tx_ref,
          transactionNumber: tx_ref,
          providerReference: tx_ref,
          type: "WALLET_FUNDING",
          category: "deposit",
          direction: "CREDIT",
          title: "Wallet Funding",
          description: "Card Payment",
          recipientName: "Self",
          creditedTo: "Available Balance",
          fundingMethod: "CARD",
          status: "PENDING",
          fee: 0,
          totalCredited: 0,
          credited: false,
          expiresAt: new Date(Date.now() + 11 * 60 * 1000).toISOString(),
          date: new Date().toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" }),
          time: new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
          transactionDate: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        }, { merge: true });
      } catch (fErr: any) {
        logger.error(`[initializePayment] Pending ledger doc write warning: ${fErr.message}`);
      }
    }

    const client = getFlutterwaveClient();
    let response: any;
    try {
      response = await client.request("post", "/payments", {
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
    } catch (pErr: any) {
      logger.error(`[initializePayment] Provider call failed: ${pErr.message}`);
      if (adminDb) {
        await adminDb.collection("transactions").doc(ledgerDocId).set({
          status: "FAILED",
          totalCredited: 0,
          credited: false,
          reason: pErr.message || "Initialization failed at payment gateway",
          updatedAt: new Date().toISOString(),
        }, { merge: true });
      }
      res.status(500).json({
        success: false,
        reference: tx_ref,
        message: pErr.message || "Failed to initialize payment with payment provider.",
      });
      return;
    }

    if (response && response.status === "success" && response.data) {
      res.status(200).json({
        success: true,
        paymentLink: response.data.link,
        reference: tx_ref,
      });
    } else {
      if (adminDb) {
        await adminDb.collection("transactions").doc(ledgerDocId).set({
          status: "FAILED",
          totalCredited: 0,
          credited: false,
          reason: response?.message || "Failed to generate payment link",
          updatedAt: new Date().toISOString(),
        }, { merge: true });
      }
      res.status(400).json({
        success: false,
        reference: tx_ref,
        message: response?.message || "Failed to initialize payment.",
      });
    }
  } catch (error: any) {
    logger.error(`[Flutterwave Controller] initializePayment exception | error=${error.message} | reqId=${reqId}`);
    res.status(500).json({
      success: false,
      message: error.message || "An internal server error occurred while initializing payment.",
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
    const { transaction_id, tx_ref } = req.body?.transaction_id || req.body?.tx_ref ? req.body : req.query;

    if (!transaction_id && !tx_ref) {
      res.status(400).json({
        success: false,
        message: "Validation Error: Either transaction_id or tx_ref query parameter is required.",
      });
      return;
    }

    const { PaymentVerificationService } = require("../services/paymentVerificationService");
    let result: any;

    if (transaction_id) {
      result = await PaymentVerificationService.verifyTransaction({
        transaction_id: String(transaction_id),
        requestId: reqId || "verify-req",
      });
    } else if (tx_ref) {
      result = await PaymentVerificationService.verifyTransactionByReference({
        tx_ref: String(tx_ref),
        requestId: reqId || "verify-req",
      });
    }

    const flwStatusRaw = result.status || (result.success ? "SUCCESSFUL" : "FAILED");
    const canonicalStatus = mapProviderStatus(flwStatusRaw);
    const referenceToUse = result.reference || tx_ref || transaction_id;
    const ledgerDocId = resolveFundingLedgerDocId(String(referenceToUse), result.flw_id || String(transaction_id));

    if (canonicalStatus === "SUCCESS") {
      const flwId = result.flw_id || String(transaction_id || "");
      const amount = Number(result.amount) || 0;
      let credited = false;
      let newBalance = 0;

      if (adminDb && flwId) {
        try {
          const userId = await resolveUserIdFromPayload(result, String(referenceToUse));

          if (userId) {
            const userRef = adminDb.collection("users").doc(userId);
            const walletRef = adminDb.collection("wallets").doc(`${userId}_NGN`);
            const ledgerRef = adminDb.collection("transactions").doc(ledgerDocId);

            await adminDb.runTransaction(async (transaction) => {
              const ledgerSnap = await transaction.get(ledgerRef);
              const ledgerData = (ledgerSnap.exists ? ledgerSnap.data() : {}) || {};

              if (ledgerSnap.exists && (ledgerData.status === "SUCCESS" || ledgerData.credited === true)) {
                logger.info(`[verifyPayment] Transaction ${ledgerDocId} already marked SUCCESS. Skipping credit.`);
                return;
              }

              const nowIso = new Date().toISOString();
              const isExpiredByTime = ledgerData.expiresAt
                ? (nowIso >= ledgerData.expiresAt)
                : (ledgerData.createdAt ? (Date.now() - new Date(ledgerData.createdAt).getTime() >= 11 * 60 * 1000) : false);

              if (ledgerSnap.exists && (ledgerData.status === "EXPIRED" || isExpiredByTime)) {
                logger.warn(`[verifyPayment] Late payment verified for EXPIRED transaction ${ledgerDocId}. Flagging for manual reconciliation.`);
                transaction.set(ledgerRef, {
                  status: "EXPIRED",
                  unmatched: true,
                  reconciliationRequired: true,
                  latePaymentReceived: true,
                  latePaymentAmount: amount,
                  latePaymentAt: nowIso,
                  reason: "Late payment verified after dynamic funding expired",
                  updatedAt: nowIso,
                }, { merge: true });
                return;
              }

              const userDoc = await transaction.get(userRef);
              if (!userDoc.exists) {
                throw new Error(`User profile document not found in Firestore for UID: ${userId}`);
              }

              const walletDoc = await transaction.get(walletRef);
              const walletExists = walletDoc.exists;

              const oldBalance = Number(userDoc.data()?.balance) || 0;
              newBalance = oldBalance + amount;

              logger.info(`[verifyPayment] Processing WALLET_FUNDING ledger and atomically crediting wallet...`);

              transaction.update(userRef, {
                balance: FieldValue.increment(amount),
                updatedAt: new Date().toISOString(),
              });

              if (walletExists) {
                transaction.update(walletRef, {
                  balance: FieldValue.increment(amount),
                  updatedAt: new Date().toISOString(),
                });
              } else {
                transaction.set(walletRef, {
                  userId,
                  currency: "NGN",
                  balance: amount,
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                });
              }

              const paymentType = ((result as any).payment_type || "").toLowerCase();
              const cardData = (result as any).card || {};
              let resolvedFundingMethod = "BANK_TRANSFER";
              let cardBrand = null;
              let cardLast4 = null;
              let maskedCardNumber = null;
              let ussdBankName = null;

              if (paymentType.includes("card") || cardData.last_4digits || cardData.last4) {
                resolvedFundingMethod = "CARD";
                const brandRaw = cardData.issuer || cardData.type || cardData.brand;
                const last4Raw = cardData.last_4digits || cardData.last4 || cardData.last4digits;
                cardBrand = brandRaw ? String(brandRaw).toUpperCase() : null;
                cardLast4 = last4Raw ? String(last4Raw) : null;
                maskedCardNumber = cardBrand && cardLast4 ? `${cardBrand} •••• ${cardLast4}` : (cardLast4 ? `•••• ${cardLast4}` : null);
              } else if (paymentType.includes("ussd")) {
                resolvedFundingMethod = "USSD";
                const ussdBankRaw = (result as any).bank_name || (result as any).account_bank;
                ussdBankName = ussdBankRaw ? String(ussdBankRaw) : null;
              }

              const senderName = (result as any).sender_name || (result as any).customer?.name || null;
              const senderBankName = (result as any).sender_bank || null;
              const senderAccountNumber = maskAccount((result as any).sender_account);
              const virtualAccountNumber = maskAccount((result as any).account_number);
              const virtualAccountBankName = (result as any).bank_name || null;

              let descStr = "Wallet Funding";
              if (resolvedFundingMethod === "CARD") {
                descStr = maskedCardNumber ? `Card Payment (${maskedCardNumber})` : "Card Payment";
              } else if (resolvedFundingMethod === "USSD") {
                descStr = ussdBankName ? `USSD • ${ussdBankName}` : "USSD Payment";
              } else {
                descStr = senderName ? `Bank Transfer • From ${senderName}` : "Bank Transfer";
              }

              const existingData = ledgerSnap.exists ? ledgerSnap.data() : {};

              transaction.set(ledgerRef, {
                userId,
                amount,
                currency: result.currency || "NGN",
                reference: referenceToUse,
                transactionNumber: referenceToUse,
                flwId,
                providerTransactionId: flwId,
                providerReference: referenceToUse,
                type: "WALLET_FUNDING",
                category: "deposit",
                direction: "CREDIT",
                title: "Wallet Funding",
                description: descStr,
                recipientName: "Self",
                creditedTo: "Available Balance",
                fundingMethod: resolvedFundingMethod,
                cardBrand,
                cardLast4,
                maskedCardNumber,
                ussdBankName,
                senderName,
                senderBankName,
                senderAccountNumber,
                virtualAccountNumber,
                virtualAccountBankName,
                status: "SUCCESS",
                credited: true,
                fee: 0,
                totalCredited: amount,
                createdAt: existingData?.createdAt || new Date().toISOString(),
                completedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              }, { merge: true });
            });

            credited = true;
            logger.info(`[verifyPayment] SUCCESS: Atomically credited user wallet! User: ${userId} | Amount: ${amount}`);
          }
        } catch (creditErr: any) {
          logger.error(`[verifyPayment] Credit Transaction FAILED for transaction_id=${flwId}: ${creditErr.message}`);
        }
      }

      res.status(200).json({
        ...result,
        credited,
        newBalance,
        message: credited
          ? `Payment verified and wallet credited successfully with ₦${amount.toLocaleString()}.`
          : "Payment verified successfully."
      });
    } else {
      if (adminDb && referenceToUse) {
        try {
          await adminDb.collection("transactions").doc(ledgerDocId).set({
            status: canonicalStatus,
            totalCredited: 0,
            credited: false,
            reason: result.message || "Payment declined or canceled",
            updatedAt: new Date().toISOString(),
          }, { merge: true });
        } catch (uErr: any) {
          logger.warn(`[verifyPayment] Failed to update pending doc status: ${uErr.message}`);
        }
      }
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
  
  const timestamp = new Date().toISOString();
  const method = req.method;
  const url = req.originalUrl || req.url;
  const ip = req.ip || req.headers["x-forwarded-for"] || (req.socket && req.socket.remoteAddress) || "UNKNOWN";
  const signature = req.headers["verif-hash"] as string || "";
  const rawBodyString = req.rawBody ? req.rawBody.toString("utf8") : JSON.stringify(req.body);

  logger.info("[Webhook] Request received");
  logger.info(`[Webhook] Timestamp: ${timestamp}`);
  logger.info(`[Webhook] Method: ${method}`);
  logger.info(`[Webhook] URL: ${url}`);
  logger.info(`[Webhook] IP Address: ${ip}`);
  const sanitizedHeaders = { ...req.headers };
  if (sanitizedHeaders["verif-hash"]) {
    sanitizedHeaders["verif-hash"] = "[REDACTED]";
  }
  logger.info("[Webhook] Headers:", sanitizedHeaders);
  logger.info("[Webhook] Signature Header Present:", !!signature);
  logger.info(`[Webhook] Raw Body Length: ${rawBodyString.length}`);

  try {
    const client = getFlutterwaveClient();
    const isSignatureValid = client.verifyWebhookSignature(signature, rawBodyString);

    if (!isSignatureValid) {
      logger.warn(`[Webhook] Invalid signature received. Header verif-hash: ${signature ? signature.substring(0, 8) + "..." : "MISSING"} | reqId=${reqId}`);
      res.status(401).json({ success: false, message: "Unauthorized signature hash mismatch" });
      return;
    }

    const payload = req.body;
    if (!payload || !payload.event) {
      res.status(400).json({ success: false, message: "Invalid webhook payload structure" });
      return;
    }

    const eventType = payload.event;
    const flwId = payload.data?.id?.toString() || payload.data?.id || "";

    if (eventType !== "charge.completed" && eventType !== "transfer.completed") {
      res.status(200).json({ success: true, message: `Webhook event ${eventType} ignored` });
      return;
    }

    if (flwId) {
      const isDuplicate = await idempotency.isWebhookDuplicate(flwId);
      if (isDuplicate) {
        logger.info(`[Webhook] Webhook flwId=${flwId} event=${eventType} already processed successfully. Replying 200 Success.`);
        res.status(200).json({ success: true, message: "Webhook already processed successfully" });
        return;
      }
    }

    if (eventType === "transfer.completed") {
      const ref = payload.data?.reference || "";
      const statusRaw = payload.data?.status || "FAILED";
      const canonicalStatus = mapProviderStatus(statusRaw);

      if (adminDb && ref) {
        try {
          const transferRef = adminDb.collection("transfers").doc(ref);
          const unifiedRef = adminDb.collection("transactions").doc(`tx-${ref}`);

          await adminDb.runTransaction(async (t) => {
            const transferSnap = await t.get(transferRef);
            if (transferSnap.exists && (transferSnap.data()?.status === "SUCCESS" || transferSnap.data()?.status === "FAILED")) {
              return;
            }

            if (canonicalStatus === "FAILED" || canonicalStatus === "REVERSED") {
              const txSnap = await t.get(unifiedRef);
              const txData = txSnap.data() || {};
              const userId = txData.userId || transferSnap.data()?.userId;
              const refundAmount = Number(txData.totalDebited) || Number(txData.amount) || 0;

              if (userId && refundAmount > 0 && adminDb) {
                const userRef = adminDb.collection("users").doc(userId);
                const walletRef = adminDb.collection("wallets").doc(`${userId}_NGN`);

                t.update(userRef, { balance: FieldValue.increment(refundAmount), updatedAt: new Date().toISOString() });
                t.update(walletRef, { balance: FieldValue.increment(refundAmount), updatedAt: new Date().toISOString() });

                const refundLedgerRef = adminDb.collection("transactions").doc(`tx-REFUND-${ref}`);
                t.set(refundLedgerRef, {
                  userId,
                  amount: refundAmount,
                  currency: "NGN",
                  reference: `REFUND-${ref}`,
                  originalReference: ref,
                  type: "REFUND",
                  category: "REFUND",
                  direction: "CREDIT",
                  title: `Reversal for Transfer to ${txData.recipientName || "Beneficiary"}`,
                  description: `Refund for failed transfer (${ref})`,
                  status: "SUCCESS",
                  totalCredited: refundAmount,
                  createdAt: new Date().toISOString(),
                });
              }
            }

            t.set(transferRef, { status: canonicalStatus, updatedAt: new Date().toISOString() }, { merge: true });
            t.set(unifiedRef, { status: canonicalStatus, updatedAt: new Date().toISOString() }, { merge: true });
          });

          if (flwId) {
            await idempotency.saveWebhookProcessed(flwId);
          }
        } catch (trErr: any) {
          logger.error(`[Webhook transfer.completed] Error updating transfer record: ${trErr.message}`);
        }
      }

      res.status(200).json({ success: true, message: "Webhook payload verified" });
      return;
    }

    if (eventType === "charge.completed") {
      const statusRaw = payload.data?.status || "FAILED";
      const canonicalStatus = mapProviderStatus(statusRaw);
      const txRef = payload.data?.tx_ref || "";
      const transactionId = flwId || "N/A";
      const ledgerDocId = resolveFundingLedgerDocId(txRef, transactionId);

      if (canonicalStatus === "SUCCESS") {
        const amount = Number(payload.data?.amount) || 0;
        const data = payload.data || {};

        const senderName = data.originatorname || data.originator_name || data.sender_name || data.customer?.name || data.meta?.senderName || undefined;
        const senderBankName = data.originatorbankname || data.originator_bank || data.sender_bank || data.meta?.senderBankName || undefined;
        const senderAccountNumber = maskAccount(data.originatoraccountnumber || data.originator_account || data.sender_account || data.meta?.senderAccountNumber);

        const virtualAccountNumber = maskAccount(data.account_number || data.virtual_account_number);
        const virtualAccountBankName = data.bank_name || data.virtual_account_bank || undefined;

        const userId = await resolveUserIdFromPayload(payload.data, txRef);

        if (userId && adminDb) {
          try {
            const userRef = adminDb.collection("users").doc(userId);
            const walletRef = adminDb.collection("wallets").doc(`${userId}_NGN`);
            const ledgerRef = adminDb.collection("transactions").doc(ledgerDocId);

            await adminDb.runTransaction(async (transaction) => {
              const ledgerSnap = await transaction.get(ledgerRef);
              const ledgerData = (ledgerSnap.exists ? ledgerSnap.data() : {}) || {};

              if (ledgerSnap.exists && (ledgerData.status === "SUCCESS" || ledgerData.credited === true)) {
                logger.info(`[Webhook charge.completed] Transaction ${ledgerDocId} already SUCCESS. Skipping credit.`);
                return;
              }

              const nowIso = new Date().toISOString();
              const isExpiredByTime = ledgerData.expiresAt
                ? (nowIso >= ledgerData.expiresAt)
                : (ledgerData.createdAt ? (Date.now() - new Date(ledgerData.createdAt).getTime() >= 11 * 60 * 1000) : false);

              if (ledgerSnap.exists && (ledgerData.status === "EXPIRED" || isExpiredByTime)) {
                logger.warn(`[Webhook charge.completed] Late payment received for EXPIRED transaction ${ledgerDocId}. Flagging for manual reconciliation.`);
                transaction.set(ledgerRef, {
                  status: "EXPIRED",
                  unmatched: true,
                  reconciliationRequired: true,
                  latePaymentReceived: true,
                  latePaymentAmount: amount,
                  latePaymentAt: nowIso,
                  reason: "Late payment received after dynamic funding expired",
                  updatedAt: nowIso,
                }, { merge: true });
                return;
              }

              const userDoc = await transaction.get(userRef);
              if (!userDoc.exists) {
                throw new Error(`User profile document not found in Firestore for UID: ${userId}`);
              }

              const walletDoc = await transaction.get(walletRef);
              const walletExists = walletDoc.exists;

              logger.info(`[Webhook charge.completed] Processing WALLET_FUNDING ledger and atomically crediting wallet...`);

              transaction.update(userRef, {
                balance: FieldValue.increment(amount),
                updatedAt: new Date().toISOString(),
              });

              if (walletExists) {
                transaction.update(walletRef, {
                  balance: FieldValue.increment(amount),
                  updatedAt: new Date().toISOString(),
                });
              } else {
                transaction.set(walletRef, {
                  userId,
                  currency: "NGN",
                  balance: amount,
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                });
              }

              const paymentType = (payload.data?.payment_type || payload.data?.type || "").toLowerCase();
              const cardData = payload.data?.card || {};
              let resolvedFundingMethod = "BANK_TRANSFER";
              let cardBrand = null;
              let cardLast4 = null;
              let maskedCardNumber = null;
              let ussdBankName = null;

              if (paymentType.includes("card") || cardData.last_4digits || cardData.last4) {
                resolvedFundingMethod = "CARD";
                const brandRaw = cardData.issuer || cardData.type || cardData.brand;
                const last4Raw = cardData.last_4digits || cardData.last4 || cardData.last4digits;
                cardBrand = brandRaw ? String(brandRaw).toUpperCase() : null;
                cardLast4 = last4Raw ? String(last4Raw) : null;
                maskedCardNumber = cardBrand && cardLast4 ? `${cardBrand} •••• ${cardLast4}` : (cardLast4 ? `•••• ${cardLast4}` : null);
              } else if (paymentType.includes("ussd")) {
                resolvedFundingMethod = "USSD";
                const ussdBankRaw = payload.data?.bank_name || payload.data?.account_bank;
                ussdBankName = ussdBankRaw ? String(ussdBankRaw) : null;
              }

              let descStr = "Wallet Funding";
              if (resolvedFundingMethod === "CARD") {
                descStr = maskedCardNumber ? `Card Payment (${maskedCardNumber})` : "Card Payment";
              } else if (resolvedFundingMethod === "USSD") {
                descStr = ussdBankName ? `USSD • ${ussdBankName}` : "USSD Payment";
              } else {
                descStr = senderName ? `Bank Transfer • From ${senderName}` : "Bank Transfer";
              }

              const existingData = ledgerSnap.exists ? ledgerSnap.data() : {};

              transaction.set(ledgerRef, {
                userId,
                amount,
                currency: payload.data?.currency || "NGN",
                reference: txRef || `DEP-${transactionId}`,
                transactionNumber: txRef || `DEP-${transactionId}`,
                flwId: flwId || transactionId,
                providerTransactionId: flwId || transactionId,
                providerReference: txRef || `DEP-${transactionId}`,
                type: "WALLET_FUNDING",
                category: "deposit",
                direction: "CREDIT",
                title: "Wallet Funding",
                description: descStr,
                recipientName: "Self",
                creditedTo: "Available Balance",
                fundingMethod: resolvedFundingMethod,
                cardBrand,
                cardLast4,
                maskedCardNumber,
                ussdBankName,
                senderName: senderName || null,
                senderBankName: senderBankName || null,
                senderAccountNumber: senderAccountNumber || null,
                virtualAccountNumber: virtualAccountNumber || null,
                virtualAccountBankName: virtualAccountBankName || null,
                status: "SUCCESS",
                credited: true,
                fee: 0,
                totalCredited: amount,
                createdAt: existingData?.createdAt || new Date().toISOString(),
                completedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              }, { merge: true });
            });

            if (flwId) {
              await idempotency.saveWebhookProcessed(flwId);
            }

            logger.info(`[Webhook charge.completed] SUCCESS: Atomically credited user wallet! User: ${userId} | Amount: ${amount}`);
          } catch (txError: any) {
            logger.error(`[Webhook charge.completed] Firestore Credit Transaction FAILED for User: ${userId} | Error: ${txError.message}`);
          }
        } else {
          logger.error(`[Webhook charge.completed] Unmatched incoming payment or user resolution failed. Payment held for manual review. Ref=${txRef}`);
          if (adminDb) {
            await adminDb.collection("transactions").doc(ledgerDocId).set({
              status: "PENDING",
              totalCredited: 0,
              credited: false,
              unmatched: true,
              reason: "Unmatched user for incoming virtual account transfer",
              updatedAt: new Date().toISOString(),
            }, { merge: true });
            if (flwId) {
              await idempotency.saveWebhookProcessed(flwId);
            }
          }
        }
      } else {
        if (adminDb) {
          try {
            await adminDb.collection("transactions").doc(ledgerDocId).set({
              status: canonicalStatus,
              totalCredited: 0,
              credited: false,
              reason: payload.data?.processor_response || payload.data?.narration || "Payment declined or canceled",
              updatedAt: new Date().toISOString(),
            }, { merge: true });
            if (flwId) {
              await idempotency.saveWebhookProcessed(flwId);
            }
          } catch (uErr: any) {
            logger.warn(`[Webhook charge.completed] Failed to update pending funding doc: ${uErr.message}`);
          }
        }
      }

      res.status(200).json({ success: true, message: "Webhook payload verified" });
      return;
    }
  } catch (error: any) {
    logger.error(`[Webhook] Error: ${error.message}`);
    res.status(500).json({ success: false, message: "Internal server error" });
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
    const cacheResult = await BankCacheService.getInstance().getBanks();
    res.status(200).json(cacheResult);
  } catch (error: any) {
    logger.error(`[Flutterwave Controller] getBanks exception | error=${error.message} | reqId=${reqId}`);
    res.status(500).json({
      success: false,
      message: "An internal server error occurred while fetching banks.",
    });
  }
};

export const refreshBanksList = async (req: Request, res: Response, next: NextFunction) => {
  const reqId = req.requestId;
  logger.info(`[Flutterwave Controller] Received refreshBanksList request | reqId=${reqId}`);

  try {
    const freshBanks = await BankCacheService.getInstance().refreshBanks();
    res.status(200).json({
      success: true,
      message: "Successfully forced immediate refresh of bank list from Flutterwave.",
      count: freshBanks.length,
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    logger.error(`[Flutterwave Controller] refreshBanksList exception | error=${error.message} | reqId=${reqId}`);
    res.status(500).json({
      success: false,
      message: error.message || "An internal server error occurred while forcing bank list refresh.",
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


export const createVirtualCard = async (req: Request, res: Response, next: NextFunction) => {
  const reqId = req.requestId;
  logger.info(`[Flutterwave Controller] Received createVirtualCard request | reqId=${reqId}`, req.body);

  try {
    const validationResult = createCardSchema.safeParse(req.body);
    if (!validationResult.success) {
      const errorMsg = validationResult.error.issues.map((e: z.ZodIssue) => `${e.path.join(".")}: ${e.message}`).join(", ");
      logger.warn(`[Flutterwave Controller] Virtual Card validation failed | errors=${errorMsg} | reqId=${reqId}`);
      res.status(400).json({
        status: "error",
        code: "VALIDATION_ERROR",
        message: `Validation Error: ${errorMsg}`,
      });
      return;
    }

    const payload = validationResult.data;
    const client = getFlutterwaveClient();

    logger.info(`[Flutterwave Controller] Sending request to Flutterwave POST /virtual-cards | reqId=${reqId}`);
    const response = await client.request("post", "/virtual-cards", payload);

    logger.info(`[Flutterwave Controller] Flutterwave virtual-cards response | reqId=${reqId}:`, response);

    if (response && response.status === "success" && response.data) {
      res.status(200).json({
        status: "success",
        message: response.message || "Virtual Card created successfully.",
        data: response.data,
      });
    } else {
      const msg = response?.message || "Virtual card creation rejected by provider.";
      let errorCode = "CARD_CREATION_FAILED";

      if (msg.toLowerCase().includes("disabled") || msg.toLowerCase().includes("not available")) {
        errorCode = "VIRTUAL_CARDS_NOT_ENABLED";
      }

      res.status(400).json({
        status: "error",
        code: errorCode,
        message: msg,
        providerResponse: response,
      });
    }
  } catch (error: any) {
    logger.error(`[Flutterwave Controller] createVirtualCard exception | error=${error.message || error} | reqId=${reqId}`);

    const errorMsg = error.message || "An internal error occurred while creating virtual card.";
    let errorCode = "PROVIDER_ERROR";

    if (errorMsg.toLowerCase().includes("disabled") || errorMsg.toLowerCase().includes("not available")) {
      errorCode = "VIRTUAL_CARDS_NOT_ENABLED";
    }

    res.status(400).json({
      status: "error",
      code: errorCode,
      message: errorMsg,
    });
  }
};

export const getVirtualCard = async (req: Request, res: Response, next: NextFunction) => {
  const reqId = req.requestId;
  const { id } = req.params;
  logger.info(`[Flutterwave Controller] Received getVirtualCard request | id=${id} | reqId=${reqId}`);

  try {
    const client = getFlutterwaveClient();
    const response = await client.request("get", `/virtual-cards/${id}`);

    if (response && response.status === "success" && response.data) {
      res.status(200).json(response);
    } else {
      res.status(400).json({
        status: "error",
        message: response?.message || "Virtual card details not found.",
      });
    }
  } catch (error: any) {
    logger.error(`[Flutterwave Controller] getVirtualCard exception | error=${error.message} | reqId=${reqId}`);
    res.status(400).json({
      status: "error",
      message: error.message || "Failed to retrieve virtual card details.",
    });
  }
};

export const fundVirtualCard = async (req: Request, res: Response, next: NextFunction) => {
  const reqId = req.requestId;
  const { id } = req.params;
  const { amount, debit_currency } = req.body;
  logger.info(`[Flutterwave Controller] Received fundVirtualCard request | id=${id} | amount=${amount} | reqId=${reqId}`);

  if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
    res.status(400).json({
      status: "error",
      message: "Valid positive numeric amount is required.",
    });
    return;
  }

  try {
    const client = getFlutterwaveClient();
    const response = await client.request("post", `/virtual-cards/${id}/fund`, {
      amount: Number(amount),
      debit_currency: debit_currency || "NGN",
    });

    if (response && response.status === "success") {
      res.status(200).json(response);
    } else {
      res.status(400).json({
        status: "error",
        message: response?.message || "Card funding rejected by provider.",
      });
    }
  } catch (error: any) {
    logger.error(`[Flutterwave Controller] fundVirtualCard exception | error=${error.message} | reqId=${reqId}`);
    res.status(400).json({
      status: "error",
      message: error.message || "Failed to fund virtual card.",
    });
  }
};

export const withdrawVirtualCard = async (req: Request, res: Response, next: NextFunction) => {
  const reqId = req.requestId;
  const { id } = req.params;
  const { amount } = req.body;
  logger.info(`[Flutterwave Controller] Received withdrawVirtualCard request | id=${id} | amount=${amount} | reqId=${reqId}`);

  if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) {
    res.status(400).json({
      status: "error",
      message: "Valid positive numeric amount is required.",
    });
    return;
  }

  try {
    const client = getFlutterwaveClient();
    const response = await client.request("post", `/virtual-cards/${id}/withdraw`, {
      amount: Number(amount),
    });

    if (response && response.status === "success") {
      res.status(200).json(response);
    } else {
      res.status(400).json({
        status: "error",
        message: response?.message || "Card withdrawal rejected by provider.",
      });
    }
  } catch (error: any) {
    logger.error(`[Flutterwave Controller] withdrawVirtualCard exception | error=${error.message} | reqId=${reqId}`);
    res.status(400).json({
      status: "error",
      message: error.message || "Failed to withdraw from virtual card.",
    });
  }
};

export const updateCardStatus = async (req: Request, res: Response, next: NextFunction) => {
  const reqId = req.requestId;
  const { id } = req.params;
  const action = req.body.status_action || req.body.action || "block";
  logger.info(`[Flutterwave Controller] Received updateCardStatus request | id=${id} | action=${action} | reqId=${reqId}`);

  try {
    const client = getFlutterwaveClient();
    const targetAction = action === "unblock" ? "unblock" : "block";
    const response = await client.request("put", `/virtual-cards/${id}/status/${targetAction}`);

    if (response && response.status === "success") {
      res.status(200).json(response);
    } else {
      res.status(400).json({
        status: "error",
        message: response?.message || "Failed to update card status.",
      });
    }
  } catch (error: any) {
    logger.error(`[Flutterwave Controller] updateCardStatus exception | error=${error.message} | reqId=${reqId}`);
    res.status(400).json({
      status: "error",
      message: error.message || "Failed to update virtual card status.",
    });
  }
};

export const terminateVirtualCard = async (req: Request, res: Response, next: NextFunction) => {
  const reqId = req.requestId;
  const { id } = req.params;
  logger.info(`[Flutterwave Controller] Received terminateVirtualCard request | id=${id} | reqId=${reqId}`);

  try {
    const client = getFlutterwaveClient();
    const response = await client.request("put", `/virtual-cards/${id}/terminate`);

    if (response && response.status === "success") {
      res.status(200).json(response);
    } else {
      res.status(400).json({
        status: "error",
        message: response?.message || "Failed to terminate card.",
      });
    }
  } catch (error: any) {
    logger.error(`[Flutterwave Controller] terminateVirtualCard exception | error=${error.message} | reqId=${reqId}`);
    res.status(400).json({
      status: "error",
      message: error.message || "Failed to terminate virtual card.",
    });
  }
};

export const getCardTransactions = async (req: Request, res: Response, next: NextFunction) => {
  const reqId = req.requestId;
  const { id } = req.params;
  logger.info(`[Flutterwave Controller] Received getCardTransactions request | id=${id} | reqId=${reqId}`);

  try {
    const client = getFlutterwaveClient();
    const response = await client.request("get", `/virtual-cards/${id}/transactions`);

    if (response && response.status === "success") {
      res.status(200).json(response);
    } else {
      res.status(400).json({
        status: "error",
        message: response?.message || "Failed to fetch card transactions.",
      });
    }
  } catch (error: any) {
    logger.error(`[Flutterwave Controller] getCardTransactions exception | error=${error.message} | reqId=${reqId}`);
    res.status(400).json({
      status: "error",
      message: error.message || "Failed to fetch card transactions.",
    });
  }
};

export const reconcileTransfer = async (req: Request, res: Response, next: NextFunction) => {
  const reqId = req.requestId;
  const { reference } = req.params;
  logger.info(`[Flutterwave Controller] Received manual reconcileTransfer request | reference=${reference} | reqId=${reqId}`);

  if (!reference) {
    res.status(400).json({
      success: false,
      message: "Transfer reference parameter is required.",
    });
    return;
  }

  try {
    const result = await ReconciliationService.getInstance().reconcileSingleTransfer(reference);
    if (result.success) {
      res.status(200).json({
        success: true,
        message: result.message,
        status: result.status,
        refunded: result.refunded || false,
        timestamp: new Date().toISOString()
      });
    } else {
      res.status(400).json({
        success: false,
        message: result.message,
        timestamp: new Date().toISOString()
      });
    }
  } catch (error: any) {
    logger.error(`[Flutterwave Controller] reconcileTransfer exception | error=${error.message} | reqId=${reqId}`);
    res.status(500).json({
      success: false,
      message: "An internal server error occurred while performing manual reconciliation.",
    });
  }
};
