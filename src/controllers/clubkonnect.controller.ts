import { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";
import logger from "../config/logger";
import { ClubkonnectService } from "../services/clubkonnect.service";
import { clubkonnectConfig } from "../config/clubkonnect";
import { adminDb } from "../config/firebase";
import { FieldValue } from "firebase-admin/firestore";
import { AuthenticatedRequest } from "../middleware/auth";
import { getFlutterwaveClient } from "../providers/flutterwave";

/**
 * Controller to handle Clubkonnect wallet balance operations.
 * Performs validation of system configurations before executing the request.
 */
export const getWalletBalance = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const reqId = req.requestId;
  logger.info(`[Clubkonnect Controller] Received getWalletBalance request | reqId=${reqId}`);

  try {
    if (!clubkonnectConfig.USER_ID) {
      logger.warn(`[Clubkonnect Controller] Validation failed: CLUBKONNECT_USER_ID is missing | reqId=${reqId}`);
      res.status(400).json({
        success: false,
        message: "Configuration Error: CLUBKONNECT_USER_ID is not configured on the gateway.",
      });
      return;
    }

    if (!clubkonnectConfig.API_KEY) {
      logger.warn(`[Clubkonnect Controller] Validation failed: CLUBKONNECT_API_KEY is missing | reqId=${reqId}`);
      res.status(400).json({
        success: false,
        message: "Configuration Error: CLUBKONNECT_API_KEY is not configured on the gateway.",
      });
      return;
    }

    const result = await ClubkonnectService.getWalletBalance(reqId);
    res.status(200).json(result);
  } catch (error: any) {
    logger.error(`[Clubkonnect Controller] getWalletBalance exception | error=${error.message} | reqId=${reqId}`);
    res.status(500).json({
      success: false,
      message: error.message || "An internal server error occurred while retrieving Clubkonnect wallet balance.",
    });
  }
};

/**
 * Exposes the available mobile networks dynamically.
 */
export const getNetworks = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const reqId = req.requestId;
  logger.info(`[Clubkonnect Controller] Received getNetworks request | reqId=${reqId}`);

  try {
    await ClubkonnectService.refreshNetworkCache(reqId);
    const { networkCache } = require("../config/clubkonnect");
    res.status(200).json({
      success: true,
      networks: Object.keys(networkCache.mappings).filter((n) => n !== "ETISALAT"),
    });
  } catch (error: any) {
    logger.error(`[Clubkonnect Controller] getNetworks exception | error=${error.message} | reqId=${reqId}`);
    res.status(500).json({ success: false, message: "Failed to load mobile networks." });
  }
};

/**
 * Exposes the mobile data plan packages dynamically.
 * Optionally supports filtering by query parameter `network` (e.g. `?network=MTN`).
 */
export const getDataPlans = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const reqId = req.requestId;
  const network = req.query.network as string | undefined;
  logger.info(`[Clubkonnect Controller] Received getDataPlans request | network=${network} | reqId=${reqId}`);

  try {
    const plans = await ClubkonnectService.getDataPlans(network, reqId);
    res.status(200).json({
      success: true,
      data: plans,
    });
  } catch (error: any) {
    logger.error(`[Clubkonnect Controller] getDataPlans exception | error=${error.message} | reqId=${reqId}`);
    res.status(500).json({ success: false, message: "Failed to load data plans." });
  }
};

/**
 * Helper to perform atomic balance verification & debit on BOTH users/{userId} and wallets/{userId}_NGN collections.
 * IMPORTANT: All Firestore transaction.get calls MUST be executed BEFORE any transaction.update or transaction.set calls!
 */
async function executeAtomicDebit(
  db: FirebaseFirestore.Firestore,
  userId: string,
  numAmount: number,
  transactionRef: string,
  purchaseRequestId: string,
  type: string,
  description: string,
  recipientName: string,
  extraVtuData: Record<string, any> = {}
) {
  const userDocRef = db.collection("users").doc(userId);
  const walletDocRef = db.collection("wallets").doc(`${userId}_NGN`);
  const ledgerRef = db.collection("transactions").doc(`tx-${transactionRef}`);
  const vtuTxRef = db.collection("vtu_transactions").doc(transactionRef);

  await db.runTransaction(async (transaction) => {
    // READ PHASE
    const userDoc = await transaction.get(userDocRef);
    const walletDoc = await transaction.get(walletDocRef);

    if (!userDoc.exists) {
      throw new Error("USER_NOT_FOUND");
    }

    const userData = userDoc.data() || {};
    const currentBalance = Number(userData.balance) || 0;

    if (currentBalance < numAmount) {
      throw new Error("INSUFFICIENT_FUNDS");
    }

    // WRITE PHASE
    // 1. Deduct balance from users/{userId}
    transaction.update(userDocRef, {
      balance: FieldValue.increment(-numAmount),
      updatedAt: new Date().toISOString(),
    });

    // 2. Deduct balance from wallets/{userId}_NGN
    if (walletDoc.exists) {
      transaction.update(walletDocRef, {
        balance: FieldValue.increment(-numAmount),
        updatedAt: new Date().toISOString(),
      });
    } else {
      transaction.set(
        walletDocRef,
        {
          userId,
          currency: "NGN",
          balance: currentBalance - numAmount,
          updatedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        },
        { merge: true }
      );
    }

    // 3. Record general ledger transaction
    transaction.set(ledgerRef, {
      userId,
      amount: numAmount,
      currency: "NGN",
      reference: transactionRef,
      type,
      description,
      recipientName,
      status: "PENDING",
      date: new Date().toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" }),
      time: new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
      fee: 0,
      createdAt: new Date().toISOString(),
    });

    // 4. Pre-create vtu_transactions entry as Pending
    transaction.set(vtuTxRef, {
      requestId: purchaseRequestId,
      transactionRef,
      userId,
      amount: numAmount,
      phone: recipientName,
      provider: "Clubkonnect",
      status: "Pending",
      type,
      createdAt: new Date().toISOString(),
      ...extraVtuData,
    });
  });

  return { ledgerRef, vtuTxRef };
}

/**
 * Helper to execute 100% rollback refund back to BOTH users/{userId} and wallets/{userId}_NGN on provider failure.
 * Idempotency guard ensures a transaction is never refunded twice.
 * IMPORTANT: All Firestore transaction.get calls MUST be executed BEFORE any transaction.update or transaction.set calls!
 */
async function executeAtomicRefund(
  db: FirebaseFirestore.Firestore,
  userId: string,
  numAmount: number,
  transactionRef: string,
  recipientName: string,
  failureReason: string,
  type: string,
  ledgerRef: FirebaseFirestore.DocumentReference,
  vtuTxRef: FirebaseFirestore.DocumentReference
): Promise<void> {
  const userDocRef = db.collection("users").doc(userId);
  const walletDocRef = db.collection("wallets").doc(`${userId}_NGN`);
  const refundLedgerRef = db.collection("transactions").doc(`tx-REFUND-${transactionRef}`);

  await db.runTransaction(async (transaction) => {
    // READ PHASE
    const freshVtuTx = await transaction.get(vtuTxRef);
    const walletDoc = await transaction.get(walletDocRef);

    const freshData = freshVtuTx.data() || {};

    if (freshData.refundProcessed) {
      logger.info(`[executeAtomicRefund] Refund already processed for ${transactionRef}. Skipping.`);
      return;
    }

    // WRITE PHASE
    // 1. Refund users/{userId}
    transaction.update(userDocRef, {
      balance: FieldValue.increment(numAmount),
      updatedAt: new Date().toISOString(),
    });

    // 2. Refund wallets/{userId}_NGN
    if (walletDoc.exists) {
      transaction.update(walletDocRef, {
        balance: FieldValue.increment(numAmount),
        updatedAt: new Date().toISOString(),
      });
    } else {
      transaction.set(
        walletDocRef,
        {
          userId,
          currency: "NGN",
          balance: FieldValue.increment(numAmount),
          updatedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        },
        { merge: true }
      );
    }

    // 3. Mark ledger as FAILED
    transaction.update(ledgerRef, {
      status: "FAILED",
      updatedAt: new Date().toISOString(),
    });

    // 4. Record REFUND general ledger doc
    transaction.set(refundLedgerRef, {
      userId,
      amount: numAmount,
      currency: "NGN",
      reference: `REFUND-${transactionRef}`,
      type: "DEPOSIT",
      description: `Auto-refund for failed ${type}: ${failureReason}`,
      recipientName,
      status: "SUCCESS",
      date: new Date().toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" }),
      time: new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
      fee: 0,
      createdAt: new Date().toISOString(),
    });

    // 5. Update vtu_transactions record
    transaction.update(vtuTxRef, {
      status: "Failed",
      failureReason: failureReason || "Provider rejection",
      refundProcessed: true,
      refundProcessedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });
}

/**
 * Handles VTU Airtime purchases.
 * Accepts alias fields: phone / customer_id, network / provider / biller_code, amount.
 * Strictly uses req.user?.uid for authenticated identity.
 */
export const purchaseAirtime = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const reqId = req.requestId;
  logger.info(`[Clubkonnect Controller] Received purchaseAirtime request | body=${JSON.stringify(req.body)} | reqId=${reqId}`);

  const networkInput = String(req.body.network || req.body.provider || req.body.biller_code || req.body.billerCode || "").trim();
  const phoneInput = String(req.body.phone || req.body.customer_id || req.body.customerId || req.body.phoneNumber || req.body.mobile_number || "").trim();
  const amountInput = req.body.amount;
  const userId = req.user?.uid;

  try {
    if (!userId) {
      logger.warn(`[Clubkonnect Controller] Unauthorized access attempt: missing req.user.uid | reqId=${reqId}`);
      res.status(401).json({
        success: false,
        message: "Unauthorized: Valid authenticated user identity token or session is required.",
      });
      return;
    }

    if (!networkInput) {
      res.status(400).json({ success: false, message: "Validation Error: Mobile network provider is required." });
      return;
    }

    const normalizedNetwork = networkInput.toUpperCase();
    const supportedNetworks = ["MTN", "GLO", "AIRTEL", "9MOBILE", "ETISALAT"];
    if (!supportedNetworks.includes(normalizedNetwork)) {
      res.status(400).json({ success: false, message: `Validation Error: Mobile network '${networkInput}' is not supported.` });
      return;
    }

    if (!phoneInput) {
      res.status(400).json({ success: false, message: "Validation Error: Recipient phone number is required." });
      return;
    }

    const cleanPhone = phoneInput.replace(/\s+/g, "");
    const nigPhoneRegex = /^(?:0|234|\+234)?[789][01]\d{8}$/;
    if (!nigPhoneRegex.test(cleanPhone)) {
      res.status(400).json({ success: false, message: "Validation Error: Please provide a valid Nigerian phone number." });
      return;
    }

    const numAmount = Number(amountInput);
    if (isNaN(numAmount) || numAmount < 50 || numAmount > 200000) {
      res.status(400).json({ success: false, message: "Validation Error: Airtime amount must be between ₦50 and ₦200,000." });
      return;
    }

    if (!adminDb) {
      res.status(500).json({ success: false, message: "Database Error: Firestore database is not initialized." });
      return;
    }

    const db = adminDb;
    const purchaseRequestId = randomUUID();
    const transactionRef = `VTU-AIR-${purchaseRequestId}`;

    let debitCommitted = false;
    let ledgerRef: FirebaseFirestore.DocumentReference;
    let vtuTxRef: FirebaseFirestore.DocumentReference;

    try {
      const resRefs = await executeAtomicDebit(
        db,
        userId,
        numAmount,
        transactionRef,
        purchaseRequestId,
        "AIRTIME",
        `Airtime purchase of ₦${numAmount} for ${cleanPhone} (${normalizedNetwork})`,
        cleanPhone,
        { network: normalizedNetwork }
      );
      ledgerRef = resRefs.ledgerRef;
      vtuTxRef = resRefs.vtuTxRef;
      debitCommitted = true;
      logger.info(`[Clubkonnect Controller] Atomic debit successful | userId=${userId} | amount=₦${numAmount} | ref=${transactionRef} | reqId=${reqId}`);
    } catch (txError: any) {
      if (txError.message === "USER_NOT_FOUND") {
        res.status(404).json({ success: false, message: "User profile not found." });
        return;
      }
      if (txError.message === "INSUFFICIENT_FUNDS") {
        res.status(400).json({ success: false, message: "Insufficient wallet balance to purchase airtime." });
        return;
      }
      res.status(500).json({ success: false, message: txError.message || "Failed to process wallet debit." });
      return;
    }

    let airtimeResult;
    try {
      airtimeResult = await ClubkonnectService.purchaseAirtime({
        network: normalizedNetwork,
        phone: cleanPhone,
        amount: numAmount,
        requestId: purchaseRequestId,
      }, reqId);
    } catch (apiError: any) {
      logger.error(`[Clubkonnect Controller] API Exception calling Clubkonnect | error=${apiError.message} | reqId=${reqId}`);
      airtimeResult = { success: false, message: apiError.message };
    }

    if (airtimeResult.success) {
      await vtuTxRef.update({
        providerOrderId: airtimeResult.orderId || null,
        updatedAt: new Date().toISOString(),
      });

      res.status(200).json({
        success: true,
        orderId: airtimeResult.orderId,
        requestId: purchaseRequestId,
        message: "Airtime purchase order received successfully. Processing...",
      });
    } else {
      logger.warn(`[Clubkonnect Controller] Airtime purchase failed, initiating Auto-Refund | reason=${airtimeResult.message} | reqId=${reqId}`);

      if (debitCommitted) {
        try {
          await executeAtomicRefund(
            db,
            userId,
            numAmount,
            transactionRef,
            cleanPhone,
            airtimeResult.message || "Provider rejection",
            "AIRTIME",
            ledgerRef!,
            vtuTxRef!
          );
          logger.info(`[Clubkonnect Controller] Auto-Refund successfully executed | ref=${transactionRef} | reqId=${reqId}`);
        } catch (refundError: any) {
          logger.error(`[Clubkonnect Controller] Critical: Auto-Refund transaction failed! | error=${refundError.message} | ref=${transactionRef}`);
        }
      }

      let userFacingMsg = `Airtime purchase failed: ${airtimeResult.message || "Provider network issue. Please try again later."}`;
      const rawMsgUpper = String(airtimeResult.message || "").toUpperCase();
      if (rawMsgUpper.includes("AIRTIME_RECIPIENT_PURCHASE_LIMIT_REACHED") || rawMsgUpper.includes("RECIPIENT_PURCHASE_LIMIT_REACHED") || rawMsgUpper.includes("PURCHASE_LIMIT_REACHED")) {
        userFacingMsg = "This recipient has reached the airtime purchase limit. Please try another phone number.";
      }

      res.status(400).json({
        success: false,
        message: userFacingMsg,
      });
    }

  } catch (error: any) {
    logger.error(`[Clubkonnect Controller] purchaseAirtime exception | error=${error.message} | reqId=${reqId}`);
    res.status(500).json({
      success: false,
      message: "Airtime purchase failed: Provider network issue. Please try again later.",
    });
  }
};

/**
 * Handles VTU Mobile Data purchases.
 * Features automated Flutterwave Bills API fallback on Clubkonnect 503 / timeout / network failure!
 */
export const purchaseData = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const reqId = req.requestId;
  logger.info(`[Clubkonnect Controller] Received purchaseData request | body=${JSON.stringify(req.body)} | reqId=${reqId}`);

  const networkInput = String(req.body.network || req.body.provider || req.body.biller_code || req.body.billerCode || "").trim();
  const phoneInput = String(req.body.phone || req.body.customer_id || req.body.customerId || req.body.phoneNumber || "").trim();
  const packageCodeInput = String(req.body.item_code || req.body.itemCode || req.body.packageCode || req.body.package_code || req.body.productCode || req.body.product_code || req.body.plan_code || req.body.planCode || req.body.variation_code || "").trim();
  const amountInput = req.body.amount;
  const userId = req.user?.uid;

  try {
    if (!userId) {
      logger.warn(`[Clubkonnect Controller] Unauthorized access attempt: missing req.user.uid | reqId=${reqId}`);
      res.status(401).json({
        success: false,
        message: "Unauthorized: Valid authenticated user identity token or session is required.",
      });
      return;
    }

    if (!networkInput) {
      res.status(400).json({ success: false, message: "Validation Error: Mobile network provider is required." });
      return;
    }

    const normalizedNetwork = networkInput.toUpperCase();
    const supportedNetworks = ["MTN", "GLO", "AIRTEL", "9MOBILE", "ETISALAT"];
    if (!supportedNetworks.includes(normalizedNetwork)) {
      res.status(400).json({ success: false, message: `Validation Error: Mobile network '${networkInput}' is not supported.` });
      return;
    }

    if (!phoneInput) {
      res.status(400).json({ success: false, message: "Validation Error: Recipient phone number is required." });
      return;
    }

    const cleanPhone = phoneInput.replace(/\s+/g, "");
    const nigPhoneRegex = /^(?:0|234|\+234)?[789][01]\d{8}$/;
    if (!nigPhoneRegex.test(cleanPhone)) {
      res.status(400).json({ success: false, message: "Validation Error: Please provide a valid Nigerian phone number." });
      return;
    }

    if (!packageCodeInput) {
      res.status(400).json({ success: false, message: "Validation Error: Selected data package code is required." });
      return;
    }

    const plans = await ClubkonnectService.getDataPlans(normalizedNetwork, reqId);
    const plan = plans.find((p) => p.item_code === packageCodeInput || p.plan_code === packageCodeInput);

    let numAmount = Number(amountInput);
    let planCode = packageCodeInput;
    let planName = "Mobile Data Package";

    if (plan) {
      numAmount = plan.amount;
      planCode = plan.plan_code;
      planName = plan.name;
    } else if (isNaN(numAmount) || numAmount <= 0) {
      res.status(400).json({ success: false, message: "Validation Error: The selected data plan package is inactive or invalid amount provided." });
      return;
    }

    if (!adminDb) {
      res.status(500).json({ success: false, message: "Database Error: Firestore database is not initialized." });
      return;
    }

    const db = adminDb;
    const purchaseRequestId = randomUUID();
    const transactionRef = `VTU-DAT-${purchaseRequestId}`;

    let debitCommitted = false;
    let ledgerRef: FirebaseFirestore.DocumentReference;
    let vtuTxRef: FirebaseFirestore.DocumentReference;

    try {
      const resRefs = await executeAtomicDebit(
        db,
        userId,
        numAmount,
        transactionRef,
        purchaseRequestId,
        "DATA",
        `Mobile Data: ${planName} to ${cleanPhone}`,
        cleanPhone,
        { network: normalizedNetwork, planName, planCode }
      );
      ledgerRef = resRefs.ledgerRef;
      vtuTxRef = resRefs.vtuTxRef;
      debitCommitted = true;
      logger.info(`[Clubkonnect Controller] Atomic debit successful | userId=${userId} | amount=₦${numAmount} | ref=${transactionRef} | reqId=${reqId}`);
    } catch (txError: any) {
      if (txError.message === "USER_NOT_FOUND") {
        res.status(404).json({ success: false, message: "User profile not found." });
        return;
      }
      if (txError.message === "INSUFFICIENT_FUNDS") {
        res.status(400).json({ success: false, message: `Insufficient wallet balance to purchase mobile data. Required: ₦${numAmount.toLocaleString()}` });
        return;
      }
      res.status(500).json({ success: false, message: txError.message || "Failed to process wallet debit." });
      return;
    }

    // 1. Primary Attempt: Call Clubkonnect
    let dataResult: any;
    let usedProvider = "Clubkonnect";

    try {
      dataResult = await ClubkonnectService.purchaseData({
        network: normalizedNetwork,
        phone: cleanPhone,
        planCode,
        requestId: purchaseRequestId,
      }, reqId);
    } catch (apiError: any) {
      logger.error(`[Clubkonnect Controller] Primary provider Clubkonnect exception | error=${apiError.message} | reqId=${reqId}`);
      dataResult = { success: false, message: apiError.message };
    }

    // 2. Secondary Failover Attempt: If ClubKonnect failed or returned 503/timeout, attempt Flutterwave Bills Fallback
    if (!dataResult.success) {
      logger.warn(`[Clubkonnect Controller] Primary provider ClubKonnect failed (${dataResult.message}). Attempting automated Flutterwave Bills API fallback... | reqId=${reqId}`);

      try {
        const flwClient = getFlutterwaveClient();
        const flwBillerType = `${normalizedNetwork}_DATA` as any;
        const flwResponse = await flwClient.request("post", "/bills", {
          country: "NG",
          customer: cleanPhone,
          amount: numAmount,
          type: flwBillerType,
          reference: transactionRef,
        });

        if (flwResponse && flwResponse.status === "success" && flwResponse.data) {
          usedProvider = "Flutterwave";
          dataResult = {
            success: true,
            orderId: flwResponse.data.tx_ref || flwResponse.data.id?.toString() || transactionRef,
            message: "Mobile data order fulfilled via Flutterwave fallback rail.",
          };
          logger.info(`[Clubkonnect Controller] SUCCESS: Mobile data purchase fulfilled via Flutterwave fallback | ref=${transactionRef} | reqId=${reqId}`);
        } else {
          logger.warn(`[Clubkonnect Controller] Fallback provider Flutterwave also rejected request: ${flwResponse?.message}`);
        }
      } catch (flwErr: any) {
        logger.error(`[Clubkonnect Controller] Fallback provider Flutterwave call exception: ${flwErr.message}`);
      }
    }

    // 3. Final Outcome: Success on either provider, or 100% Auto-Refund if both failed
    if (dataResult.success) {
      await vtuTxRef.update({
        provider: usedProvider,
        providerOrderId: dataResult.orderId || null,
        status: "Delivered",
        updatedAt: new Date().toISOString(),
      });

      await ledgerRef!.update({
        status: "SUCCESS",
        updatedAt: new Date().toISOString(),
      });

      res.status(200).json({
        success: true,
        provider: usedProvider,
        orderId: dataResult.orderId,
        requestId: purchaseRequestId,
        message: "Data plan purchase processed successfully.",
      });
    } else {
      logger.warn(`[Clubkonnect Controller] All providers failed for Mobile Data. Initiating Auto-Refund | reason=${dataResult.message} | reqId=${reqId}`);

      if (debitCommitted) {
        try {
          await executeAtomicRefund(
            db,
            userId,
            numAmount,
            transactionRef,
            cleanPhone,
            dataResult.message || "All providers unavailable",
            "DATA",
            ledgerRef!,
            vtuTxRef!
          );
          logger.info(`[Clubkonnect Controller] Auto-Refund successfully executed | ref=${transactionRef} | reqId=${reqId}`);
        } catch (refundError: any) {
          logger.error(`[Clubkonnect Controller] Critical: Auto-Refund transaction failed! | error=${refundError.message} | ref=${transactionRef}`);
        }
      }

      res.status(400).json({
        success: false,
        message: `Data purchase failed: ${dataResult.message || "Provider network issue. Please try again later."}`,
      });
    }

  } catch (error: any) {
    logger.error(`[Clubkonnect Controller] purchaseData exception | error=${error.message} | reqId=${reqId}`);
    res.status(500).json({
      success: false,
      message: "Data purchase failed: Provider network issue. Please try again later.",
    });
  }
};

/**
 * Handles Cable TV Subscription purchases.
 * Fails safely if integration/provider is unavailable without mock success or fake order IDs.
 */
export const purchaseCable = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const reqId = req.requestId;
  logger.info(`[Clubkonnect Controller] Received purchaseCable request | body=${JSON.stringify(req.body)} | reqId=${reqId}`);

  const targetId = String(req.body.smartCardNo || req.body.smart_card_no || req.body.customer_id || req.body.customerId || req.body.phone || req.body.iuc || req.body.account_number || "").trim();
  const providerInput = String(req.body.provider || req.body.network || req.body.biller_code || req.body.billerCode || "").trim().toUpperCase();
  const packageCodeInput = String(req.body.packageCode || req.body.package_code || req.body.item_code || req.body.itemCode || req.body.productCode || req.body.plan_code || "").trim();
  const amountInput = req.body.amount;
  const userId = req.user?.uid;

  try {
    if (!userId) {
      logger.warn(`[Clubkonnect Controller] Unauthorized access attempt: missing req.user.uid | reqId=${reqId}`);
      res.status(401).json({ success: false, message: "Unauthorized: Valid authenticated user identity token or session is required." });
      return;
    }

    if (!targetId) {
      res.status(400).json({ success: false, message: "Validation Error: SmartCard/IUC number is required." });
      return;
    }

    if (!providerInput) {
      res.status(400).json({ success: false, message: "Validation Error: Cable TV provider is required." });
      return;
    }

    const numAmount = Number(amountInput);
    if (isNaN(numAmount) || numAmount <= 0) {
      res.status(400).json({ success: false, message: "Validation Error: Valid positive subscription amount is required." });
      return;
    }

    logger.warn(`[Clubkonnect Controller] Cable TV purchase requested but provider service rail is unavailable | reqId=${reqId}`);
    res.status(503).json({
      success: false,
      message: "Cable TV purchase failed: Provider service rail is temporarily unavailable. No funds were debited.",
    });

  } catch (error: any) {
    logger.error(`[Clubkonnect Controller] purchaseCable exception | error=${error.message} | reqId=${reqId}`);
    res.status(500).json({
      success: false,
      message: "Cable TV purchase failed: Provider network issue. Please try again later.",
    });
  }
};

/**
 * Handles Electricity Bill Payment.
 * Fails safely if integration/provider is unavailable without mock success or fake electricity tokens.
 */
export const purchaseElectricity = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const reqId = req.requestId;
  logger.info(`[Clubkonnect Controller] Received purchaseElectricity request | body=${JSON.stringify(req.body)} | reqId=${reqId}`);

  const targetId = String(req.body.meterNo || req.body.meter_no || req.body.customer_id || req.body.customerId || req.body.phone || req.body.account_number || "").trim();
  const providerInput = String(req.body.provider || req.body.network || req.body.biller_code || req.body.billerCode || "").trim().toUpperCase();
  const amountInput = req.body.amount;
  const userId = req.user?.uid;

  try {
    if (!userId) {
      logger.warn(`[Clubkonnect Controller] Unauthorized access attempt: missing req.user.uid | reqId=${reqId}`);
      res.status(401).json({ success: false, message: "Unauthorized: Valid authenticated user identity token or session is required." });
      return;
    }

    if (!targetId) {
      res.status(400).json({ success: false, message: "Validation Error: Meter number is required." });
      return;
    }

    if (!providerInput) {
      res.status(400).json({ success: false, message: "Validation Error: Electricity DISCO provider is required." });
      return;
    }

    const numAmount = Number(amountInput);
    if (isNaN(numAmount) || numAmount <= 0) {
      res.status(400).json({ success: false, message: "Validation Error: Valid positive electricity amount is required." });
      return;
    }

    logger.warn(`[Clubkonnect Controller] Electricity purchase requested but provider service rail is unavailable | reqId=${reqId}`);
    res.status(503).json({
      success: false,
      message: "Electricity bill payment failed: Provider service rail is temporarily unavailable. No funds were debited.",
    });

  } catch (error: any) {
    logger.error(`[Clubkonnect Controller] purchaseElectricity exception | error=${error.message} | reqId=${reqId}`);
    res.status(500).json({
      success: false,
      message: "Electricity bill payment failed: Provider network issue. Please try again later.",
    });
  }
};

/**
 * Handles WAEC / Exam Result Checker PIN purchase.
 * Fails safely if integration/provider is unavailable without mock success or fake PINs.
 */
export const purchaseWaec = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const reqId = req.requestId;
  logger.info(`[Clubkonnect Controller] Received purchaseWaec request | body=${JSON.stringify(req.body)} | reqId=${reqId}`);

  const targetId = String(req.body.customer_id || req.body.customerId || req.body.phone || req.body.smartCardNo || req.body.meterNo || "").trim();
  const amountInput = req.body.amount;
  const userId = req.user?.uid;

  try {
    if (!userId) {
      logger.warn(`[Clubkonnect Controller] Unauthorized access attempt: missing req.user.uid | reqId=${reqId}`);
      res.status(401).json({ success: false, message: "Unauthorized: Valid authenticated user identity token or session is required." });
      return;
    }

    const numAmount = Number(amountInput) || 3800;

    logger.warn(`[Clubkonnect Controller] WAEC PIN purchase requested but provider service rail is unavailable | reqId=${reqId}`);
    res.status(503).json({
      success: false,
      message: "WAEC PIN purchase failed: Provider service rail is temporarily unavailable. No funds were debited.",
    });

  } catch (error: any) {
    logger.error(`[Clubkonnect Controller] purchaseWaec exception | error=${error.message} | reqId=${reqId}`);
    res.status(500).json({
      success: false,
      message: "WAEC PIN purchase failed: Provider network issue. Please try again later.",
    });
  }
};

/**
 * Handles Clubkonnect callback notifications with strict double-refund guards.
 * IMPORTANT: All Firestore transaction.get calls MUST be executed BEFORE any transaction.update or transaction.set calls!
 */
export const handleCallback = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const reqId = req.requestId;
  const payload = { ...req.query, ...req.body };
  logger.info(`[Clubkonnect Callback] Received notification callback | payload=${JSON.stringify(payload)} | reqId=${reqId}`);

  try {
    const status = String(payload.status || "").trim().toLowerCase();
    const orderId = String(payload.orderid || payload.orderId || "").trim();
    const callbackRequestId = String(payload.requestid || payload.requestId || "").trim();

    if (!orderId && !callbackRequestId) {
      res.status(400).json({ success: false, message: "Missing orderid or requestid." });
      return;
    }

    if (!adminDb) {
      res.status(500).json({ success: false, message: "Database offline." });
      return;
    }

    const db = adminDb;

    let vtuQuerySnap;
    if (callbackRequestId) {
      vtuQuerySnap = await db.collection("vtu_transactions").where("requestId", "==", callbackRequestId).limit(1).get();
    } else {
      vtuQuerySnap = await db.collection("vtu_transactions").where("providerOrderId", "==", orderId).limit(1).get();
    }

    if (!vtuQuerySnap || vtuQuerySnap.empty) {
      res.status(404).json({ success: false, message: "Transaction record not found." });
      return;
    }

    const vtuTxDoc = vtuQuerySnap.docs[0];
    const vtuTxRef = vtuTxDoc.ref;
    const vtuTxData = vtuTxDoc.data() || {};
    const transactionRef = vtuTxData.transactionRef;

    const currentVtuStatus = String(vtuTxData.status || "").trim().toUpperCase();

    if (currentVtuStatus === "DELIVERED" || currentVtuStatus === "FAILED" || currentVtuStatus === "REFUNDED") {
      res.status(200).json({ success: true, message: "Callback processed (idempotent skip)." });
      return;
    }

    const userId = vtuTxData.userId;
    const amount = Number(vtuTxData.amount) || 0;
    const phone = vtuTxData.phone;

    let targetStatus: "Delivered" | "Failed" = "Delivered";
    let isFailure = false;

    if (status === "failed" || status === "cancelled" || status === "refunded") {
      targetStatus = "Failed";
      isFailure = true;
    }

    const userDocRef = db.collection("users").doc(userId);
    const walletDocRef = db.collection("wallets").doc(`${userId}_NGN`);
    const ledgerRef = db.collection("transactions").doc(`tx-${transactionRef}`);

    await db.runTransaction(async (transaction) => {
      // READ PHASE
      const freshVtuTx = await transaction.get(vtuTxRef);
      const walletDoc = await transaction.get(walletDocRef);

      const freshData = freshVtuTx.data() || {};
      const freshStatus = String(freshData.status || "").trim().toUpperCase();

      if (freshStatus === "DELIVERED" || freshStatus === "FAILED" || freshStatus === "REFUNDED") {
        return;
      }

      const updatePayload: Record<string, any> = {
        status: targetStatus,
        callbackPayload: payload,
        updatedAt: new Date().toISOString(),
      };

      // WRITE PHASE
      if (isFailure && !freshData.refundProcessed) {
        // Re-credit users/{userId}
        transaction.update(userDocRef, {
          balance: FieldValue.increment(amount),
          updatedAt: new Date().toISOString(),
        });

        // Re-credit wallets/{userId}_NGN
        if (walletDoc.exists) {
          transaction.update(walletDocRef, {
            balance: FieldValue.increment(amount),
            updatedAt: new Date().toISOString(),
          });
        } else {
          transaction.set(
            walletDocRef,
            {
              userId,
              currency: "NGN",
              balance: FieldValue.increment(amount),
              updatedAt: new Date().toISOString(),
              createdAt: new Date().toISOString(),
            },
            { merge: true }
          );
        }

        transaction.update(ledgerRef, {
          status: "FAILED",
          updatedAt: new Date().toISOString(),
        });

        const refundLedgerRef = db.collection("transactions").doc(`tx-REFUND-${transactionRef}`);
        transaction.set(refundLedgerRef, {
          userId,
          amount,
          currency: "NGN",
          reference: `REFUND-${transactionRef}`,
          type: "DEPOSIT",
          description: `Refund for failed ${freshData.type || "VTU"} callback: ${payload.remark || "Provider delivery failure"}`,
          recipientName: phone || "Self",
          status: "SUCCESS",
          date: new Date().toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" }),
          time: new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
          fee: 0,
          createdAt: new Date().toISOString(),
        });

        updatePayload.refundProcessed = true;
        updatePayload.refundProcessedAt = new Date().toISOString();
      } else {
        transaction.update(ledgerRef, {
          status: "SUCCESS",
          updatedAt: new Date().toISOString(),
        });
      }

      transaction.update(vtuTxRef, updatePayload);
    });

    res.status(200).json({ success: true, message: `Callback completed successfully. Transaction is ${targetStatus}.` });

  } catch (error: any) {
    logger.error(`[Clubkonnect Callback] Exception handling callback | error=${error.message} | reqId=${reqId}`);
    res.status(500).json({ success: false, message: "An error occurred during callback validation." });
  }
};
