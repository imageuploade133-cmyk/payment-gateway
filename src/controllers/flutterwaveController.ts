import { Request, Response, NextFunction } from "express";
import { getFlutterwaveClient } from "../providers/flutterwave";
import { z } from "zod";
import { logger } from "../config/logger";
import { adminDb } from "../config/firebase";
import { FieldValue } from "firebase-admin/firestore";
import { FirestoreIdempotency } from "../services/firestoreIdempotency";
import { TransferService } from "../services/transferService";
import { ReconciliationService } from "../services/reconciliationService";
import { mapProviderStatus } from "../utils/statusMapper";
import { parseUserIdFromTxRef, resolveFundingLedgerDocId } from "../utils/userIdParser";

const idempotency = FirestoreIdempotency.getInstance();
const transferService = new TransferService();

export interface AuthenticatedRequest extends Request {
  user?: {
    uid: string;
    email?: string;
    role?: string;
  };
}

const maskAccount = (num?: string): string | null => {
  if (!num) return null;
  const str = String(num).trim();
  if (str.length <= 4) return str;
  return `****${str.slice(-4)}`;
};

const resolveUserIdFromPayload = async (data: any, txRef: string): Promise<string | null> => {
  // 1. payload.data.meta.userId
  if (data?.meta?.userId) {
    return String(data.meta.userId).trim();
  }
  // 2. payload.data.meta.user_id
  if (data?.meta?.user_id) {
    return String(data.meta.user_id).trim();
  }
  // 3. user-wallet-<uid> or 4. flw-tx-<uid>-<suffix>
  const parsedUid = parseUserIdFromTxRef(txRef);
  if (parsedUid) {
    return parsedUid;
  }
  // 5. verified customer email lookup
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
};

const initializePaymentSchema = z.object({
  amount: z.number().positive(),
  currency: z.string().optional().default("NGN"),
  email: z.string().email(),
  name: z.string().min(1),
  userId: z.string().min(1),
  redirectUrl: z.string().url().optional(),
  phone: z.string().optional(),
});

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

export const verifyPayment = async (req: Request, res: Response, next: NextFunction) => {
  const reqId = req.requestId;
  logger.info(`[Flutterwave Controller] Received verifyPayment request | reqId=${reqId}`);

  try {
    const { transaction_id, tx_ref } = req.query;

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
              if (ledgerSnap.exists && (ledgerSnap.data()?.status === "SUCCESS" || ledgerSnap.data()?.credited === true)) {
                logger.info(`[verifyPayment] Transaction ${ledgerDocId} already marked SUCCESS. Skipping credit.`);
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

  logger.info("[Webhook] Request received");
  logger.info(`[Webhook] Signature Header Present: ${!!signature}`);

  try {
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
        } catch (trErr: any) {
          logger.error(`[Webhook transfer.completed] Error updating transfer record: ${trErr.message}`);
        }
      }

      res.status(200).json({ success: true, message: "Transfer webhook processed" });
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
              if (ledgerSnap.exists && (ledgerSnap.data()?.status === "SUCCESS" || ledgerSnap.data()?.credited === true)) {
                logger.info(`[Webhook charge.completed] Transaction ${ledgerDocId} already SUCCESS. Skipping credit.`);
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
          } catch (uErr: any) {
            logger.warn(`[Webhook charge.completed] Failed to update pending funding doc: ${uErr.message}`);
          }
        }
      }

      res.status(200).json({ success: true, message: "Charge webhook processed" });
      return;
    }
  } catch (error: any) {
    logger.error(`[Webhook] Error: ${error.message}`);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
};

export const executeTransfer = async (req: Request, res: Response, next: NextFunction) => {
  const reqId = req.requestId;
  try {
    const payload = req.body;
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
      fee: typeof req.body.fee === "number" ? req.body.fee : (req.body.fee ? Number(req.body.fee) : undefined),
      markup: typeof req.body.markup === "number" ? req.body.markup : (req.body.markup ? Number(req.body.markup) : 0),
      vat: typeof req.body.vat === "number" ? req.body.vat : (req.body.vat ? Number(req.body.vat) : 0),
    });

    res.status(200).json(result);
  } catch (error: any) {
    logger.error(`[Flutterwave Controller] executeTransfer error: ${error.message}`);
    res.status(500).json({ success: false, message: error.message });
  }
};

export const proxy = async (req: Request, res: Response, next: NextFunction) => {
  res.status(500).json({ success: false, message: "Not implemented" });
};

export const getBanks = async (req: Request, res: Response, next: NextFunction) => {
  res.status(500).json({ success: false, message: "Not implemented" });
};

export const refreshBanksList = async (req: Request, res: Response, next: NextFunction) => {
  res.status(500).json({ success: false, message: "Not implemented" });
};

export const getExchangeRates = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const client = getFlutterwaveClient();
    const response = await client.request("get", "/rates?from=USD&to=NGN&amount=1");
    res.status(200).json(response);
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getTransferFee = async (req: Request, res: Response, next: NextFunction) => {
  res.status(500).json({ success: false, message: "Not implemented" });
};

export const resolveAccount = async (req: Request, res: Response, next: NextFunction) => {
  res.status(500).json({ success: false, message: "Not implemented" });
};

export const initiateTransfer = async (req: Request, res: Response, next: NextFunction) => {
  res.status(500).json({ success: false, message: "Not implemented" });
};

export const initiateBulkTransfer = async (req: Request, res: Response, next: NextFunction) => {
  res.status(500).json({ success: false, message: "Not implemented" });
};

export const charge = async (req: Request, res: Response, next: NextFunction) => {
  res.status(500).json({ success: false, message: "Not implemented" });
};

export const payBill = async (req: Request, res: Response, next: NextFunction) => {
  res.status(500).json({ success: false, message: "Not implemented" });
};

export const getKycStatus = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  res.status(500).json({ success: false, message: "Not implemented" });
};

export const createVirtualAccount = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  res.status(500).json({ success: false, message: "Not implemented" });
};

export const verifyTransfer = async (req: Request, res: Response, next: NextFunction) => {
  res.status(500).json({ success: false, message: "Not implemented" });
};

export const getTransferStatus = async (req: Request, res: Response, next: NextFunction) => {
  res.status(500).json({ success: false, message: "Not implemented" });
};

export const createVirtualCard = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const client = getFlutterwaveClient();
    const response = await client.request("post", "/virtual-cards", req.body);
    res.status(200).json(response);
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getVirtualCard = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const client = getFlutterwaveClient();
    const response = await client.request("get", `/virtual-cards/${req.params.id}`);
    res.status(200).json(response);
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const fundVirtualCard = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const client = getFlutterwaveClient();
    const response = await client.request("post", `/virtual-cards/${req.params.id}/fund`, req.body);
    res.status(200).json(response);
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const withdrawVirtualCard = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const client = getFlutterwaveClient();
    const response = await client.request("post", `/virtual-cards/${req.params.id}/withdraw`, req.body);
    res.status(200).json(response);
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const updateCardStatus = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const client = getFlutterwaveClient();
    const response = await client.request("put", `/virtual-cards/${req.params.id}/status`, req.body);
    res.status(200).json(response);
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const terminateVirtualCard = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const client = getFlutterwaveClient();
    const response = await client.request("put", `/virtual-cards/${req.params.id}/terminate`, req.body);
    res.status(200).json(response);
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getCardTransactions = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const client = getFlutterwaveClient();
    const response = await client.request("get", `/virtual-cards/${req.params.id}/transactions`);
    res.status(200).json(response);
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const reconcileTransfer = async (req: Request, res: Response, next: NextFunction) => {
  const reqId = req.requestId;
  const { reference } = req.params;
  if (!reference) {
    res.status(400).json({ success: false, message: "Transfer reference parameter is required." });
    return;
  }
  try {
    const result = await ReconciliationService.getInstance().reconcileSingleTransfer(reference);
    res.status(result.success ? 200 : 400).json(result);
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
};
