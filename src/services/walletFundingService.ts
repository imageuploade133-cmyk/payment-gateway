import { adminDb } from "../config/firebase";
import { FieldValue } from "firebase-admin/firestore";
import logger from "../config/logger";
import { extractSenderInfo } from "../utils/senderExtractor";
import { parseUserIdFromTxRef, isValidFlwId, resolveFundingLedgerDocId } from "../utils/userIdParser";
import { NotificationService } from "./notificationService";
import { FirestoreIdempotency } from "./firestoreIdempotency";

const idempotency = FirestoreIdempotency.getInstance();

export interface UserResolutionResult {
  userId: string | null;
  ambiguous: boolean;
}

export interface AtomicFundingCreditParams {
  flwId: string;
  txRef: string;
  amount: number;
  currency: string;
  payloadData?: any;
  explicitUserId?: string | null;
  requestId?: string;
  source?: "webhook" | "verify" | "reconciliation";
}

export interface AtomicFundingCreditResult {
  success: boolean;
  credited: boolean;
  alreadyCredited: boolean;
  isExpired?: boolean;
  unmatched?: boolean;
  ambiguous?: boolean;
  totalCredited: number;
  newBalance: number;
  userId?: string;
  message?: string;
  ledgerDocId: string;
}

function maskAccount(num?: string): string | null {
  if (!num) return null;
  const str = String(num).trim();
  if (str.length <= 4) return str;
  return `****${str.slice(-4)}`;
}

/**
 * Safely resolves the target user ID from transaction payload data without guessing or defaulting.
 * Strictly checks for duplicate/ambiguous matches and returns ambiguous: true if multiple records match.
 */
export async function resolveUserIdSafely(data: any, txRef: string): Promise<UserResolutionResult> {
  // 1. Direct metadata check
  if (data?.meta?.userId) {
    const uid = String(data.meta.userId).trim();
    if (uid) return { userId: uid, ambiguous: false };
  }
  if (data?.meta?.user_id) {
    const uid = String(data.meta.user_id).trim();
    if (uid) return { userId: uid, ambiguous: false };
  }

  // 2. Parse txRef (e.g. user-wallet-<uid> or flw-tx-<uid>-<ts>)
  const parsedUid = parseUserIdFromTxRef(txRef);
  if (parsedUid) {
    return { userId: parsedUid, ambiguous: false };
  }

  if (!adminDb) {
    return { userId: null, ambiguous: false };
  }

  // 3. Virtual / Bank Account Number Lookup
  const rawAcc = data?.account_number || data?.virtual_account_number || data?.meta?.account_number || data?.customer?.account_number;
  if (rawAcc) {
    const cleanAcc = String(rawAcc).trim().replace(/\D/g, "");
    if (cleanAcc.length >= 8) {
      try {
        // A. wallet_accounts lookup: prefer doc.data()?.userId over doc.id
        const waSnap = await adminDb.collection("wallet_accounts").where("accountNumber", "==", cleanAcc).get();
        if (!waSnap.empty) {
          const userIds = Array.from(new Set(
            waSnap.docs
              .map(doc => doc.data()?.userId)
              .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
          ));

          if (userIds.length === 1) {
            logger.info(`[resolveUserIdSafely] Unambiguously resolved userId=${userIds[0]} from wallet_accounts for accountNumber=${cleanAcc}`);
            return { userId: userIds[0], ambiguous: false };
          } else if (userIds.length > 1) {
            logger.warn(`[resolveUserIdSafely] Multiple unique userIds (${userIds.join(", ")}) found in wallet_accounts for accountNumber=${cleanAcc}. Treating as AMBIGUOUS.`);
            return { userId: null, ambiguous: true };
          }
        }

        // B. users collection virtualAccountNumber lookup
        const uSnap1 = await adminDb.collection("users").where("virtualAccountNumber", "==", cleanAcc).get();
        if (!uSnap1.empty) {
          const userIds = Array.from(new Set(
            uSnap1.docs
              .map(doc => doc.data()?.userId || doc.id)
              .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
          ));

          if (userIds.length === 1) {
            logger.info(`[resolveUserIdSafely] Unambiguously resolved userId=${userIds[0]} from users via virtualAccountNumber=${cleanAcc}`);
            return { userId: userIds[0], ambiguous: false };
          } else if (userIds.length > 1) {
            logger.warn(`[resolveUserIdSafely] Multiple unique userIds found in users for virtualAccountNumber=${cleanAcc}. Treating as AMBIGUOUS.`);
            return { userId: null, ambiguous: true };
          }
        }

        // C. users collection accountNumber lookup
        const uSnap2 = await adminDb.collection("users").where("accountNumber", "==", cleanAcc).get();
        if (!uSnap2.empty) {
          const userIds = Array.from(new Set(
            uSnap2.docs
              .map(doc => doc.data()?.userId || doc.id)
              .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
          ));

          if (userIds.length === 1) {
            logger.info(`[resolveUserIdSafely] Unambiguously resolved userId=${userIds[0]} from users via accountNumber=${cleanAcc}`);
            return { userId: userIds[0], ambiguous: false };
          } else if (userIds.length > 1) {
            logger.warn(`[resolveUserIdSafely] Multiple unique userIds found in users for accountNumber=${cleanAcc}. Treating as AMBIGUOUS.`);
            return { userId: null, ambiguous: true };
          }
        }
      } catch (accErr: any) {
        logger.error(`[resolveUserIdSafely] Account number lookup failed for ${cleanAcc}: ${accErr.message}`);
      }
    }
  }

  // 4. Email lookup - only when exactly one user matches
  const email = data?.customer?.email;
  if (email && typeof email === "string" && email.trim().length > 0) {
    const cleanEmail = email.toLowerCase().trim();
    try {
      const snap = await adminDb.collection("users").where("email", "==", cleanEmail).get();
      if (!snap.empty) {
        const userIds = Array.from(new Set(
          snap.docs.map(doc => doc.id).filter((id): id is string => typeof id === "string" && id.trim().length > 0)
        ));

        if (userIds.length === 1) {
          logger.info(`[resolveUserIdSafely] Unambiguously resolved userId=${userIds[0]} from users via email=${cleanEmail}`);
          return { userId: userIds[0], ambiguous: false };
        } else if (userIds.length > 1) {
          logger.warn(`[resolveUserIdSafely] Multiple unique userIds (${userIds.join(", ")}) match email=${cleanEmail}. Treating as AMBIGUOUS.`);
          return { userId: null, ambiguous: true };
        }
      }
    } catch (emailErr: any) {
      logger.error(`[resolveUserIdSafely] Email lookup failed for ${cleanEmail}: ${emailErr.message}`);
    }
  }

  return { userId: null, ambiguous: false };
}

export async function dispatchCreditNotification(
  userId: string,
  amount: number,
  currency: string,
  reference: string,
  ledgerDocId: string
): Promise<void> {
  if (!adminDb) return;
  const db = adminDb;
  const txRefDoc = db.collection("transactions").doc(ledgerDocId);

  let shouldDispatch = false;
  const now = Date.now();
  const leaseTimeoutMs = 60 * 1000;

  try {
    await db.runTransaction(async (t) => {
      const snap = await t.get(txRefDoc);
      if (!snap.exists) return;

      const data = snap.data() || {};

      if (data.notificationStatus === "SENT" || data.creditedNotificationSent === true) {
        return;
      }

      if (data.notificationStatus === "PROCESSING" && data.notificationLeaseExpiresAt) {
        if (now < Number(data.notificationLeaseExpiresAt)) {
          return;
        }
      }

      t.set(txRefDoc, {
        notificationStatus: "PROCESSING",
        notificationLeaseExpiresAt: now + leaseTimeoutMs,
        notificationLastAttemptAt: new Date().toISOString()
      }, { merge: true });

      shouldDispatch = true;
    });

    if (!shouldDispatch) {
      logger.info(`[dispatchCreditNotification] Notification already SENT or currently PROCESSING for tx=${ledgerDocId}. Skipping.`);
      return;
    }

    const formattedAmt = amount.toLocaleString("en-NG", { minimumFractionDigits: 2 });
    logger.info(`[dispatchCreditNotification] Dispatching FCM push notification to user=${userId} for ₦${formattedAmt} | ref=${reference}`);

    await NotificationService.sendPushNotification(userId, {
      title: "💰 Money Received",
      body: `₦${formattedAmt} has been credited to your wallet.`,
      type: "transaction",
      reference,
      amount,
      currency: currency || "NGN"
    });

    await txRefDoc.set({
      notificationStatus: "SENT",
      creditedNotificationSent: true,
      creditedNotificationSentAt: new Date().toISOString(),
      notificationLeaseExpiresAt: null
    }, { merge: true });

    logger.info(`[dispatchCreditNotification] SUCCESS: FCM push notification delivered and marked SENT for user=${userId} | tx=${ledgerDocId}`);

  } catch (fcmErr: any) {
    logger.error(`[dispatchCreditNotification Error] FCM dispatch failed for user=${userId} | tx=${ledgerDocId}: ${fcmErr.message}`);

    try {
      await txRefDoc.set({
        notificationStatus: "FAILED",
        notificationLeaseExpiresAt: null,
        notificationLastError: fcmErr.message || "FCM delivery failed"
      }, { merge: true });
    } catch (relErr: any) {
      logger.error(`[dispatchCreditNotification Release Error] Failed releasing notification lease for tx=${ledgerDocId}: ${relErr.message}`);
    }
  }
}

export class WalletFundingService {
  /**
   * Authoritative single shared atomic wallet credit function used across Webhooks, Verification, and Reconciliation.
   * Uses canonical tx-FUNDING-flw-${flwId} document ID and atomic Firestore transactions.
   */
  public static async executeAtomicWalletCredit(params: AtomicFundingCreditParams): Promise<AtomicFundingCreditResult> {
    const { flwId, txRef, amount, currency, payloadData, explicitUserId, requestId, source } = params;
    const cleanFlwId = String(flwId || "").trim();
    const cleanTxRef = String(txRef || "").trim();
    const cleanCurrency = String(currency || "NGN").toUpperCase();

    const ledgerDocId = resolveFundingLedgerDocId(cleanTxRef, cleanFlwId);

    logger.info(
      `[WalletFundingService] Received atomic credit request | flwId=${cleanFlwId} | txRef=${cleanTxRef} | amount=${amount} | currency=${cleanCurrency} | source=${source || "unknown"} | reqId=${requestId || "n/a"}`
    );

    // 1. Validation: flwId must be valid
    if (!isValidFlwId(cleanFlwId)) {
      logger.error(`[WalletFundingService] Automatic credit refused: invalid flwId '${cleanFlwId}'. txRef='${cleanTxRef}'`);
      if (adminDb && ledgerDocId !== "tx-FUNDING-UNKNOWN") {
        try {
          await adminDb.collection("transactions").doc(ledgerDocId).set({
            status: "PENDING",
            totalCredited: 0,
            credited: false,
            unmatched: true,
            reason: "Automatic credit refused due to missing or invalid flwId identity",
            updatedAt: new Date().toISOString(),
          }, { merge: true });
        } catch (err: any) {
          logger.warn(`[WalletFundingService] Error flagging unmatched tx without valid flwId: ${err.message}`);
        }
      }
      return {
        success: false,
        credited: false,
        alreadyCredited: false,
        totalCredited: 0,
        newBalance: 0,
        ledgerDocId,
        message: "Valid Flutterwave provider transaction ID (flwId) is required for automatic wallet crediting.",
      };
    }

    // 2. Validation: Amount must be positive
    if (typeof amount !== "number" || isNaN(amount) || amount <= 0) {
      logger.error(`[WalletFundingService] Credit refused: non-positive amount ${amount} for flwId=${cleanFlwId}`);
      return {
        success: false,
        credited: false,
        alreadyCredited: false,
        totalCredited: 0,
        newBalance: 0,
        ledgerDocId,
        message: "Amount must be a positive number greater than zero.",
      };
    }

    // 3. Validation: Currency must be NGN (or supported)
    if (cleanCurrency !== "NGN") {
      logger.error(`[WalletFundingService] Credit refused: unsupported currency ${cleanCurrency} for flwId=${cleanFlwId}`);
      return {
        success: false,
        credited: false,
        alreadyCredited: false,
        totalCredited: 0,
        newBalance: 0,
        ledgerDocId,
        message: `Unsupported currency '${cleanCurrency}'. Automatic wallet crediting strictly supports NGN.`,
      };
    }

    if (!adminDb) {
      return {
        success: false,
        credited: false,
        alreadyCredited: false,
        totalCredited: 0,
        newBalance: 0,
        ledgerDocId,
        message: "Firestore database service is not initialized.",
      };
    }

    const db = adminDb;

    // 4. Resolve target user ID safely
    let targetUid = explicitUserId || null;
    let isAmbiguous = false;

    if (!targetUid) {
      const res = await resolveUserIdSafely(payloadData, cleanTxRef);
      targetUid = res.userId;
      isAmbiguous = res.ambiguous;
    }

    if (!targetUid) {
      const reasonMsg = isAmbiguous
        ? "Ambiguous account ownership: multiple users match this account or email"
        : "Unmatched user for incoming virtual account funding";

      logger.error(`[WalletFundingService] User resolution failed for flwId=${cleanFlwId} | txRef=${cleanTxRef} | ambiguous=${isAmbiguous}`);

      try {
        await db.collection("transactions").doc(ledgerDocId).set({
          status: "PENDING",
          totalCredited: 0,
          credited: false,
          unmatched: true,
          ambiguous: isAmbiguous,
          reason: reasonMsg,
          updatedAt: new Date().toISOString(),
        }, { merge: true });
      } catch (err: any) {
        logger.warn(`[WalletFundingService] Error marking transaction unmatched: ${err.message}`);
      }

      return {
        success: false,
        credited: false,
        alreadyCredited: false,
        unmatched: true,
        ambiguous: isAmbiguous,
        totalCredited: 0,
        newBalance: 0,
        ledgerDocId,
        message: reasonMsg,
      };
    }

    // 5. Execute Atomic Firestore Transaction
    try {
      const userRef = db.collection("users").doc(targetUid);
      const walletRef = db.collection("wallets").doc(`${targetUid}_NGN`);
      const ledgerRef = db.collection("transactions").doc(ledgerDocId);

      const txOutcome = await db.runTransaction(async (transaction) => {
        const ledgerSnap = await transaction.get(ledgerRef);
        const ledgerData = (ledgerSnap.exists ? ledgerSnap.data() : {}) || {};

        // Idempotency check: Already credited?
        if (ledgerSnap.exists && (ledgerData.status === "SUCCESS" || ledgerData.credited === true)) {
          logger.info(`[WalletFundingService] Transaction ${ledgerDocId} is already credited/SUCCESS. Skipping atomic credit.`);
          const userDoc = await transaction.get(userRef);
          const currentBal = Number(userDoc.data()?.balance) || 0;
          return {
            credited: false,
            alreadyCredited: true,
            isExpired: false,
            totalCredited: Number(ledgerData.totalCredited || ledgerData.amount || amount),
            newBalance: currentBal,
          };
        }

        const userDoc = await transaction.get(userRef);
        if (!userDoc.exists) {
          throw new Error(`User profile document not found in Firestore for UID: ${targetUid}`);
        }

        const walletDoc = await transaction.get(walletRef);
        const walletExists = walletDoc.exists;

        const oldBalance = Number(userDoc.data()?.balance) || 0;
        const userData = userDoc.data() || {};
        const currentDebt = Math.max(0, Number(userData.outstandingDebt) || 0);

        // Integer minor units calculation to prevent floating point imprecision
        const amountMinor = Math.round(amount * 100);
        const debtMinor = Math.round(currentDebt * 100);

        const debtRecoveredMinor = Math.min(amountMinor, debtMinor);
        const netCreditMinor = amountMinor - debtRecoveredMinor;

        const debtRecovered = debtRecoveredMinor / 100;
        const netCredit = netCreditMinor / 100;
        const updatedBal = oldBalance + netCredit;

        logger.info(
          `[WalletFundingService] Crediting user ${targetUid} via ${source || "atomic"}: Gross=₦${amount}, DebtRecovered=₦${debtRecovered}, NetCredit=₦${netCredit}`
        );

        const userUpdates: Record<string, any> = {
          balance: FieldValue.increment(netCredit),
          updatedAt: new Date().toISOString(),
        };

        if (debtRecovered > 0) {
          userUpdates.outstandingDebt = FieldValue.increment(-debtRecovered);
        }

        transaction.update(userRef, userUpdates);

        if (walletExists) {
          transaction.update(walletRef, {
            balance: FieldValue.increment(netCredit),
            updatedAt: new Date().toISOString(),
          });
        } else {
          transaction.set(walletRef, {
            userId: targetUid,
            currency: "NGN",
            balance: netCredit,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        }

        // Record debt recovery transaction if applicable
        if (debtRecovered > 0) {
          const debtTxRef = `recovery-${cleanTxRef || cleanFlwId}`;
          const debtTxDocRef = db.collection("transactions").doc(`tx-${debtTxRef}`);
          transaction.set(debtTxDocRef, {
            userId: targetUid,
            amount: debtRecovered,
            currency: "NGN",
            reference: debtTxRef,
            type: "DEBT_RECOVERY",
            category: "DEDUCTION",
            direction: "DEBIT",
            description: `Automatic Recovery for Outstanding Debt (₦${debtRecovered.toLocaleString()})`,
            recipientName: "System Recovery",
            status: "SUCCESS",
            date: new Date().toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" }),
            time: new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
            fee: 0,
            totalDebited: debtRecovered,
            totalCredited: 0,
            createdAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            metadata: {
              fundingReference: cleanTxRef || cleanFlwId,
              recoveredAmount: debtRecovered,
              originalAmount: amount,
            },
          });
        }

        // Extract metadata and sender details
        const extractedSender = extractSenderInfo(payloadData || {});
        const existingData = ledgerSnap.exists ? ledgerSnap.data() : {};

        const senderName = extractedSender.senderName || existingData?.senderName || payloadData?.sender_name || null;
        const senderBankName = extractedSender.senderBankName || existingData?.senderBankName || payloadData?.sender_bank || null;
        const senderAccountNumber = maskAccount(extractedSender.senderAccountNumber || payloadData?.sender_account) || existingData?.senderAccountNumber || null;
        const virtualAccountNumber = maskAccount(payloadData?.account_number || payloadData?.virtual_account_number) || existingData?.virtualAccountNumber || null;
        const virtualAccountBankName = payloadData?.bank_name || payloadData?.virtual_account_bank || existingData?.virtualAccountBankName || null;

        const paymentType = String(payloadData?.payment_type || payloadData?.type || "").toLowerCase();
        const cardData = payloadData?.card || {};
        let resolvedFundingMethod = existingData?.fundingMethod || "BANK_TRANSFER";
        let cardBrand = existingData?.cardBrand || null;
        let cardLast4 = existingData?.cardLast4 || null;
        let maskedCardNumber = existingData?.maskedCardNumber || null;
        let ussdBankName = existingData?.ussdBankName || null;

        if (paymentType.includes("card") || cardData.last_4digits || cardData.last4) {
          resolvedFundingMethod = "CARD";
          const brandRaw = cardData.issuer || cardData.type || cardData.brand;
          const last4Raw = cardData.last_4digits || cardData.last4 || cardData.last4digits;
          cardBrand = brandRaw ? String(brandRaw).toUpperCase() : null;
          cardLast4 = last4Raw ? String(last4Raw) : null;
          maskedCardNumber = cardBrand && cardLast4 ? `${cardBrand} •••• ${cardLast4}` : (cardLast4 ? `•••• ${cardLast4}` : null);
        } else if (paymentType.includes("ussd")) {
          resolvedFundingMethod = "USSD";
          const ussdBankRaw = payloadData?.bank_name || payloadData?.account_bank;
          ussdBankName = ussdBankRaw ? String(ussdBankRaw) : null;
        }

        let descStr = existingData?.description || "Wallet Funding";
        if (resolvedFundingMethod === "CARD") {
          descStr = maskedCardNumber ? `Card Payment (${maskedCardNumber})` : "Card Payment";
        } else if (resolvedFundingMethod === "USSD") {
          descStr = ussdBankName ? `USSD • ${ussdBankName}` : "USSD Payment";
        } else {
          descStr = senderName ? `Transfer From ${senderName}` : (existingData?.description || "Bank Transfer");
        }

        // Commit transaction ledger document
        transaction.set(ledgerRef, {
          userId: targetUid,
          amount,
          currency: cleanCurrency,
          reference: cleanTxRef || `DEP-${cleanFlwId}`,
          transactionNumber: cleanTxRef || `DEP-${cleanFlwId}`,
          flwId: cleanFlwId,
          providerTransactionId: cleanFlwId,
          providerReference: cleanTxRef || `DEP-${cleanFlwId}`,
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
          unmatched: false,
          reconciled: source === "reconciliation" ? true : (existingData?.reconciled || false),
          reconciledAt: source === "reconciliation" ? new Date().toISOString() : (existingData?.reconciledAt || null),
          fee: 0,
          totalCredited: amount,
          createdAt: existingData?.createdAt || new Date().toISOString(),
          completedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }, { merge: true });

        return {
          credited: true,
          alreadyCredited: false,
          isExpired: false,
          totalCredited: amount,
          newBalance: updatedBal,
        };
      });

      if (txOutcome.credited || txOutcome.alreadyCredited) {
        if (txOutcome.credited) {
          logger.info(`[WalletFundingService] SUCCESS: Atomically credited user ${targetUid} with ₦${amount} for flwId=${cleanFlwId}`);
        }
        dispatchCreditNotification(targetUid, amount, cleanCurrency, cleanTxRef || `DEP-${cleanFlwId}`, ledgerDocId)
          .catch((err) => logger.error(`[WalletFundingService] dispatchCreditNotification exception: ${err.message}`));

        await idempotency.saveWebhookProcessed(cleanFlwId);
      }

      return {
        success: true,
        credited: txOutcome.credited,
        alreadyCredited: txOutcome.alreadyCredited,
        totalCredited: txOutcome.totalCredited,
        newBalance: txOutcome.newBalance,
        userId: targetUid,
        ledgerDocId,
        message: txOutcome.alreadyCredited
          ? "Transaction is already credited."
          : `Wallet credited successfully with ₦${amount.toLocaleString()}.`,
      };

    } catch (error: any) {
      logger.error(`[WalletFundingService] Credit Transaction FAILED for flwId=${cleanFlwId}: ${error.message}`);
      return {
        success: false,
        credited: false,
        alreadyCredited: false,
        totalCredited: 0,
        newBalance: 0,
        ledgerDocId,
        message: `Atomic wallet credit failed: ${error.message}`,
      };
    }
  }
}
