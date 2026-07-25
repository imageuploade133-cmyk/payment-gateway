import { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";
import logger from "../config/logger";
import { ClubkonnectService } from "../services/clubkonnect.service";
import { clubkonnectConfig } from "../config/clubkonnect";
import { adminDb } from "../config/firebase";
import { FieldValue } from "firebase-admin/firestore";
import { AuthenticatedRequest } from "../middleware/auth";

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
 * Handles VTU Airtime purchases.
 * 1. Validates inputs.
 * 2. Authenticates and retrieves the User ID from the Firebase token (Option 1).
 * 3. Atomic wallet verification and debit via Firestore Transactions.
 * 4. Dispatches the purchase operation to Clubkonnect.
 * 5. Handles success by saving transaction metadata, and auto-refunds on immediate failure.
 */
export const purchaseAirtime = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const reqId = req.requestId;
  logger.info(`[Clubkonnect Controller] Received purchaseAirtime request | body=${JSON.stringify(req.body)} | reqId=${reqId}`);

  const { network, phone, amount } = req.body;
  // Option 1: Strictly identify and authenticate the user via the verified Firebase ID Token
  const userId = req.user?.uid;

  try {
    // 1. Inputs validation
    if (!userId) {
      logger.warn(`[Clubkonnect Controller] Missing userId | reqId=${reqId}`);
      res.status(401).json({
        success: false,
        message: "Unauthorized: Missing authenticated user context. This endpoint requires the client to send a valid Firebase ID Token in the 'Authorization: Bearer <Token>' header, along with the Gateway S2S API Key in the 'X-API-Key' header.",
      });
      return;
    }

    if (!network || typeof network !== "string") {
      logger.warn(`[Clubkonnect Controller] Missing or invalid network | reqId=${reqId}`);
      res.status(400).json({ success: false, message: "Validation Error: Mobile network provider is required." });
      return;
    }

    const normalizedNetwork = network.trim().toUpperCase();
    const supportedNetworks = ["MTN", "GLO", "AIRTEL", "9MOBILE", "ETISALAT"];
    if (!supportedNetworks.includes(normalizedNetwork)) {
      logger.warn(`[Clubkonnect Controller] Unsupported network: ${network} | reqId=${reqId}`);
      res.status(400).json({ success: false, message: `Validation Error: Mobile network '${network}' is not supported.` });
      return;
    }

    if (!phone || typeof phone !== "string") {
      logger.warn(`[Clubkonnect Controller] Missing phone number | reqId=${reqId}`);
      res.status(400).json({ success: false, message: "Validation Error: Recipient phone number is required." });
      return;
    }

    // Clean phone number (remove spaces, etc.)
    const cleanPhone = phone.trim().replace(/\s+/g, "");
    // Nigerian Phone number regex: matches optionally 0, 234, or +234 followed by 7, 8, 9, 0, 1 and then 8 digits
    const nigPhoneRegex = /^(?:0|234|\+234)?[789][01]\d{8}$/;
    if (!nigPhoneRegex.test(cleanPhone)) {
      logger.warn(`[Clubkonnect Controller] Invalid Nigerian phone number: ${phone} | reqId=${reqId}`);
      res.status(400).json({ success: false, message: "Validation Error: Please provide a valid Nigerian phone number." });
      return;
    }

    const numAmount = Number(amount);
    if (isNaN(numAmount) || numAmount < 50 || numAmount > 200000) {
      logger.warn(`[Clubkonnect Controller] Invalid amount: ${amount} | reqId=${reqId}`);
      res.status(400).json({ success: false, message: "Validation Error: Airtime amount must be between ₦50 and ₦200,000." });
      return;
    }

    if (!adminDb) {
      logger.error(`[Clubkonnect Controller] Firestore is not initialized | reqId=${reqId}`);
      res.status(500).json({ success: false, message: "Database Error: Firestore database is not initialized." });
      return;
    }

    const db = adminDb;

    // Generate unique Request ID
    const purchaseRequestId = randomUUID();
    const transactionRef = `VTU-AIR-${purchaseRequestId}`;

    const userDocRef = db.collection("users").doc(userId);
    const ledgerRef = db.collection("transactions").doc(`tx-${transactionRef}`);
    const vtuTxRef = db.collection("vtu_transactions").doc(transactionRef);

    let debitCommitted = false;

    // 2. Atomic Wallet Verification & Debit Transaction
    try {
      await db.runTransaction(async (transaction) => {
        const userDoc = await transaction.get(userDocRef);
        if (!userDoc.exists) {
          throw new Error("USER_NOT_FOUND");
        }

        const userData = userDoc.data() || {};
        const currentBalance = Number(userData.balance) || 0;

        if (currentBalance < numAmount) {
          throw new Error("INSUFFICIENT_FUNDS");
        }

        // Deduct balance atomically
        transaction.update(userDocRef, {
          balance: FieldValue.increment(-numAmount)
        });

        // Record general ledger transaction record
        transaction.set(ledgerRef, {
          userId,
          amount: numAmount,
          currency: "NGN",
          reference: transactionRef,
          type: "AIRTIME",
          description: `Airtime purchase of ₦${numAmount} for ${cleanPhone} (${normalizedNetwork})`,
          recipientName: cleanPhone,
          status: "PENDING",
          date: new Date().toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" }),
          time: new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
          fee: 0,
          createdAt: new Date().toISOString(),
        });

        // Pre-create the vtu transaction as Pending
        transaction.set(vtuTxRef, {
          requestId: purchaseRequestId,
          transactionRef,
          userId,
          amount: numAmount,
          phone: cleanPhone,
          network: normalizedNetwork,
          provider: "Clubkonnect",
          status: "Pending",
          createdAt: new Date().toISOString(),
        });
      });

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
      throw txError;
    }

    // 3. Call Clubkonnect Airtime API
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

    // 4. Handle results & fallback Auto-refund if failed
    if (airtimeResult.success) {
      // Keep as Pending and update OrderID
      await vtuTxRef.update({
        providerOrderId: airtimeResult.orderId || null,
        updatedAt: new Date().toISOString(),
      });

      logger.info(`[Clubkonnect Controller] Airtime order successfully submitted | orderId=${airtimeResult.orderId} | reqId=${reqId}`);
      res.status(200).json({
        success: true,
        orderId: airtimeResult.orderId,
        requestId: purchaseRequestId,
        message: "Airtime purchase order received successfully. Processing...",
      });
    } else {
      logger.warn(`[Clubkonnect Controller] Purchase failed on provider, initiating Auto-Refund | reason=${airtimeResult.message} | reqId=${reqId}`);

      // Perform Auto-Refund Transaction
      if (debitCommitted) {
        try {
          await db.runTransaction(async (transaction) => {
            // Re-credit the wallet
            transaction.update(userDocRef, {
              balance: FieldValue.increment(numAmount)
            });

            // Update ledger record status to FAILED
            transaction.update(ledgerRef, {
              status: "FAILED",
              updatedAt: new Date().toISOString()
            });

            // Log refund ledger record
            const refundLedgerRef = db.collection("transactions").doc(`tx-REFUND-${transactionRef}`);
            transaction.set(refundLedgerRef, {
              userId,
              amount: numAmount,
              currency: "NGN",
              reference: `REFUND-${transactionRef}`,
              type: "DEPOSIT",
              description: `Auto-refund for failed Airtime: ${airtimeResult.message}`,
              recipientName: cleanPhone,
              status: "SUCCESS",
              date: new Date().toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" }),
              time: new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
              fee: 0,
              createdAt: new Date().toISOString(),
            });

            // Update vtu transaction status to Failed
            transaction.update(vtuTxRef, {
              status: "Failed",
              failureReason: airtimeResult.message || "Provider rejection",
              refundProcessed: true,
              refundProcessedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            });
          });

          logger.info(`[Clubkonnect Controller] Auto-Refund successfully executed | ref=${transactionRef} | reqId=${reqId}`);
        } catch (refundError: any) {
          logger.error(`[Clubkonnect Controller] Critical: Auto-Refund transaction failed! | error=${refundError.message} | ref=${transactionRef} | reqId=${reqId}`);
        }
      }

      res.status(400).json({
        success: false,
        message: `Airtime purchase failed: ${airtimeResult.message || "Unknown provider error."}`,
      });
    }

  } catch (error: any) {
    logger.error(`[Clubkonnect Controller] purchaseAirtime exception | error=${error.message} | reqId=${reqId}`);
    res.status(500).json({
      success: false,
      message: "An internal server error occurred while processing airtime purchase.",
    });
  }
};

/**
 * Handles Clubkonnect callback notifications.
 * Validates and processes status updates (delivered, failed, etc.)
 * Executes idempotent refunds on failure or cancellation.
 */
export const handleCallback = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const reqId = req.requestId;
  // Support both POST body and GET query parameters
  const payload = { ...req.query, ...req.body };
  logger.info(`[Clubkonnect Callback] Received notification callback | payload=${JSON.stringify(payload)} | reqId=${reqId}`);

  try {
    const status = String(payload.status || "").trim().toLowerCase();
    const orderId = String(payload.orderid || payload.orderId || "").trim();
    const callbackRequestId = String(payload.requestid || payload.requestId || "").trim();

    if (!orderId && !callbackRequestId) {
      logger.warn(`[Clubkonnect Callback] Missing identifying parameters | reqId=${reqId}`);
      res.status(400).json({ success: false, message: "Missing orderid or requestid." });
      return;
    }

    if (!adminDb) {
      logger.error(`[Clubkonnect Callback] Firestore is offline | reqId=${reqId}`);
      res.status(500).json({ success: false, message: "Database offline." });
      return;
    }

    const db = adminDb;

    // 1. Retrieve the matching VTU Transaction
    let vtuQuerySnap;
    if (callbackRequestId) {
      vtuQuerySnap = await db.collection("vtu_transactions").where("requestId", "==", callbackRequestId).limit(1).get();
    } else {
      vtuQuerySnap = await db.collection("vtu_transactions").where("providerOrderId", "==", orderId).limit(1).get();
    }

    if (!vtuQuerySnap || vtuQuerySnap.empty) {
      logger.warn(`[Clubkonnect Callback] Matching VTU transaction not found for orderId=${orderId} requestId=${callbackRequestId} | reqId=${reqId}`);
      res.status(404).json({ success: false, message: "Transaction record not found." });
      return;
    }

    const vtuTxDoc = vtuQuerySnap.docs[0];
    const vtuTxRef = vtuTxDoc.ref;
    const vtuTxData = vtuTxDoc.data() || {};
    const transactionRef = vtuTxData.transactionRef;

    const currentVtuStatus = String(vtuTxData.status || "").trim().toUpperCase();

    // Skip processing if already terminated
    if (currentVtuStatus === "DELIVERED" || currentVtuStatus === "FAILED" || currentVtuStatus === "REFUNDED") {
      logger.info(`[Clubkonnect Callback] Transaction ${transactionRef} is already in a terminal state: ${currentVtuStatus}. Skipping.`);
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
    const ledgerRef = db.collection("transactions").doc(`tx-${transactionRef}`);

    // 2. Atomically update transaction status and refund if failed (Idempotent single transaction)
    await db.runTransaction(async (transaction) => {
      const freshVtuTx = await transaction.get(vtuTxRef);
      const freshData = freshVtuTx.data() || {};
      const freshStatus = String(freshData.status || "").trim().toUpperCase();

      if (freshStatus === "DELIVERED" || freshStatus === "FAILED" || freshStatus === "REFUNDED") {
        logger.info(`[Clubkonnect Callback Transaction] Concurrent skip: terminal state ${freshStatus}`);
        return;
      }

      const updatePayload: Record<string, any> = {
        status: targetStatus,
        callbackPayload: payload,
        updatedAt: new Date().toISOString(),
      };

      if (isFailure && !freshData.refundProcessed) {
        logger.info(`[Clubkonnect Callback] Executing Callback Refund | userId=${userId} | amount=₦${amount} | ref=${transactionRef}`);

        // Re-credit the wallet
        transaction.update(userDocRef, {
          balance: FieldValue.increment(amount)
        });

        // Update main general ledger record status to FAILED
        transaction.update(ledgerRef, {
          status: "FAILED",
          updatedAt: new Date().toISOString()
        });

        // Create refund general ledger ledger item
        const refundLedgerRef = db.collection("transactions").doc(`tx-REFUND-${transactionRef}`);
        transaction.set(refundLedgerRef, {
          userId,
          amount,
          currency: "NGN",
          reference: `REFUND-${transactionRef}`,
          type: "DEPOSIT",
          description: `Refund for failed Airtime callback: ${payload.remark || "Provider delivery failure"}`,
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
        // Successful delivery update ledger status to SUCCESS
        transaction.update(ledgerRef, {
          status: "SUCCESS",
          updatedAt: new Date().toISOString()
        });
      }

      transaction.update(vtuTxRef, updatePayload);
    });

    logger.info(`[Clubkonnect Callback] Successfully finalized transaction ${transactionRef} as status: ${targetStatus} | reqId=${reqId}`);
    res.status(200).json({ success: true, message: `Callback completed successfully. Transaction is ${targetStatus}.` });

  } catch (error: any) {
    logger.error(`[Clubkonnect Callback] Exception handling callback | error=${error.message} | reqId=${reqId}`);
    res.status(500).json({ success: false, message: "An error occurred during callback validation." });
  }
};
