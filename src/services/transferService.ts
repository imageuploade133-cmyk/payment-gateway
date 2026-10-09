import { getFlutterwaveClient } from "../providers/flutterwave";
import logger from "../config/logger";
import { FirestoreIdempotency } from "./firestoreIdempotency";
import { adminDb } from "../config/firebase";
import { NotificationService } from "./notificationService";
import { FieldValue } from "firebase-admin/firestore";

export interface IdempotencyProvider {
  isDuplicate(reference: string): Promise<boolean>;
  saveReference(reference: string): Promise<void>;
  claimReference?(reference: string, provider?: string): Promise<boolean>;
}

export class InMemoryIdempotency implements IdempotencyProvider {
  private static instance: InMemoryIdempotency;
  public cache = new Set<string>();
  private insertionOrder: string[] = [];
  private maxKeys = 10000;

  private constructor() {}

  public static getInstance(): InMemoryIdempotency {
    if (!InMemoryIdempotency.instance) {
      InMemoryIdempotency.instance = new InMemoryIdempotency();
    }
    return InMemoryIdempotency.instance;
  }

  public async isDuplicate(reference: string): Promise<boolean> {
    return this.cache.has(reference);
  }

  public async saveReference(reference: string): Promise<void> {
    if (this.cache.has(reference)) return;
    if (this.cache.size >= this.maxKeys) {
      const oldest = this.insertionOrder.shift();
      if (oldest) this.cache.delete(oldest);
    }
    this.cache.add(reference);
    this.insertionOrder.push(reference);
  }
}

export interface InitiateTransferParams {
  amount: number;
  account_number: string;
  bank_code: string;
  account_name: string;
  currency: string;
  narration: string;
  reference: string;
  requestId: string;
  userId?: string;
  fee?: number;
  vat?: number;
  markup?: number;
  bank_name?: string;
}

export interface TransferResult {
  success: boolean;
  processing?: boolean;
  reference: string;
  provider_reference?: string;
  status: "success" | "pending" | "failed";
  message?: string;
  flutterwaveStatus?: string;
}

const TRANSFER_PENDING_EXPIRY_MS = 24 * 60 * 60 * 1000;

export class TransferService {
  private idempotencyProvider: IdempotencyProvider;

  constructor(idempotencyProvider: IdempotencyProvider = FirestoreIdempotency.getInstance()) {
    this.idempotencyProvider = idempotencyProvider;
  }

  public async executeTransfer(params: InitiateTransferParams): Promise<TransferResult> {
    const { amount, account_number, bank_code, account_name, currency = "NGN", narration, reference, requestId, userId, fee = 0, vat = 0, markup = 0, bank_name } = params;

    const totalDebited = amount + fee + markup + vat;
    let localDebitPerformed = false;

    logger.info(
      `[TransferService] Starting transfer process | reference=${reference} | amount=${amount} | fee=${fee} | markup=${markup} | totalDebited=${totalDebited} | account=${account_number} | reqId=${requestId}`
    );

    // Atomically reserve the reference before contacting Flutterwave.
    if (typeof this.idempotencyProvider.claimReference === "function") {
      const claimed = await this.idempotencyProvider.claimReference(reference, "flutterwave");
      if (!claimed) {
        return {
          success: false,
          reference,
          status: "failed",
          message: "Duplicate transfer reference or transaction reservation unavailable.",
        };
      }
    } else {
      const isDuplicate = await this.idempotencyProvider.isDuplicate(reference);
      if (isDuplicate) {
        return {
          success: false,
          reference,
          status: "failed",
          message: "Duplicate transfer reference. This transaction has already been initiated.",
        };
      }
      await this.idempotencyProvider.saveReference(reference);
    }

    // 1. Atomically verify wallet balance and deduct totalDebited (amount + fee + markup + vat) if not already debited by caller
    if (adminDb && userId && userId !== "N/A") {
      const db = adminDb;
      try {
        const unifiedTxRef = db.collection("transactions").doc(`tx-${reference}`);
        const userRef = db.collection("users").doc(userId);
        const walletRef = db.collection("wallets").doc(`${userId}_${currency || "NGN"}`);

        const debitResult = await db.runTransaction(async (t) => {
          const txSnap = await t.get(unifiedTxRef);
          if (txSnap.exists) {
            const txData = txSnap.data() || {};
            // If already debited by caller (e.g. Next.js WalletService.debitWallet), skip double debit
            if (txData.direction === "DEBIT" || txData.type === "TRANSFER") {
              logger.info(`[TransferService] Transaction tx-${reference} already debited by caller. Skipping double debit.`);
              return { success: true, alreadyDebited: true };
            }
          }

          const userSnap = await t.get(userRef);
          if (!userSnap.exists) {
            return { success: false, error: "User profile document not found." };
          }

          const walletSnap = await t.get(walletRef);
          const currentWalletBal = walletSnap.exists ? Number(walletSnap.data()?.balance || 0) : 0;
          const currentUserBal = Number(userSnap.data()?.balance || 0);
          const availableBal = walletSnap.exists ? currentWalletBal : currentUserBal;

          if (availableBal < totalDebited) {
            return {
              success: false,
              error: `Insufficient wallet balance to complete transfer. Required: ₦${totalDebited.toLocaleString(undefined, { minimumFractionDigits: 2 })}, Available: ₦${availableBal.toLocaleString(undefined, { minimumFractionDigits: 2 })}`,
            };
          }

          t.update(userRef, {
            balance: FieldValue.increment(-totalDebited),
            updatedAt: new Date().toISOString(),
          });

          if (walletSnap.exists) {
            t.update(walletRef, {
              balance: FieldValue.increment(-totalDebited),
              updatedAt: new Date().toISOString(),
            });
          }

          const createdAtIso = new Date().toISOString();
          t.set(unifiedTxRef, {
            userId,
            amount,
            currency: currency || "NGN",
            reference,
            transactionNumber: reference,
            type: "TRANSFER",
            category: "transfer",
            direction: "DEBIT",
            title: "Transfer To",
            description: `Transfer to ${account_name}`,
            narration: narration || null,
            remark: narration || null,
            recipientName: account_name,
            recipientBankName: bank_name || null,
            recipientAccountNumber: account_number,
            beneficiaryName: account_name,
            beneficiaryAccountNumber: account_number,
            beneficiaryBankCode: bank_code,
            beneficiaryBankName: bank_name || null,
            fee,
            transferFee: fee,
            vat,
            markup,
            totalDebited,
            status: "PENDING",
            transactionDate: createdAtIso,
            createdAt: createdAtIso,
          }, { merge: true });

          return { success: true, alreadyDebited: false };
        });

        if (!debitResult.success) {
          logger.warn(`[TransferService] Wallet debit failed for reference=${reference}: ${debitResult.error}`);
          return {
            success: false,
            reference,
            status: "failed",
            message: debitResult.error || "Insufficient wallet balance to execute transfer.",
          };
        }

        if (!debitResult.alreadyDebited) {
          localDebitPerformed = true;
          logger.info(`[TransferService] Successfully debited ₦${totalDebited} from user=${userId} for ref=${reference}`);
        }

      } catch (debitErr: any) {
        logger.error(`[TransferService] Wallet debit transaction exception for ref=${reference}: ${debitErr.message}`);
        return {
          success: false,
          reference,
          status: "failed",
          message: "Failed to execute wallet balance deduction.",
        };
      }
    }

    // 2. Call Flutterwave transfer provider
    try {
      const client = getFlutterwaveClient();
      const payload = {
        account_bank: bank_code,
        account_number,
        amount,
        narration,
        currency,
        reference,
        callback_url: undefined,
      };

      const response = await client.request("post", "/transfers", payload);

      if (response && response.status === "success" && response.data) {
        const flwId = response.data.id?.toString();
        const flwStatus = (response.data.status?.toLowerCase() || "new");
        const dbStatus = (flwStatus === "successful" || flwStatus === "success")
          ? "success"
          : (flwStatus === "failed" ? "failed" : "pending");

        await (this.idempotencyProvider as any).saveReference(reference, "flutterwave", dbStatus, flwId);

        const createdAt = new Date();
        const createdAtIso = createdAt.toISOString();
        const expiresAt = new Date(createdAt.getTime() + TRANSFER_PENDING_EXPIRY_MS).toISOString();

        if (adminDb) {
          try {
            await adminDb.collection("transfers").doc(reference).set({
              transferReference: reference,
              flutterwaveTransferId: flwId || null,
              providerTransferId: flwId || null,
              providerReference: flwId || null,
              reference,
              userId: userId || "N/A",
              amount,
              currency: currency || "NGN",
              fee,
              transferFee: fee,
              vat,
              markup,
              totalDebited,
              bankCode: bank_code,
              bankName: bank_name || null,
              accountNumber: account_number,
              recipientName: account_name,
              recipientBankName: bank_name || null,
              recipientAccountNumber: account_number,
              beneficiaryName: account_name,
              beneficiaryAccountNumber: account_number,
              beneficiaryBankCode: bank_code,
              beneficiaryBankName: bank_name || null,
              recipient: { account_number, bank_code, account_name },
              provider: "Flutterwave",
              status: dbStatus === "success" ? "SUCCESS" : dbStatus === "failed" ? "FAILED" : "PENDING",
              flutterwaveStatus: flwStatus,
              type: "TRANSFER",
              category: "TRANSFER",
              direction: "DEBIT",
              description: `Transfer to ${account_name}`,
              narration: narration || null,
              remark: narration || null,
              createdAt: createdAtIso,
              expiresAt,
            }, { merge: true });

            const unifiedTxRef = adminDb.collection("transactions").doc(`tx-${reference}`);
            await unifiedTxRef.set({
              providerReference: flwId || null,
              providerTransactionId: flwId || null,
              transactionNumber: reference,
              provider: "Flutterwave",
              status: dbStatus === "success" ? "SUCCESS" : dbStatus === "failed" ? "FAILED" : "PENDING",
              type: "TRANSFER",
              category: "transfer",
              direction: "outgoing",
              title: "Transfer To",
              description: `Transfer to ${account_name}`,
              narration: narration || null,
              remark: narration || null,
              recipientName: account_name,
              recipientBankName: bank_name || null,
              recipientAccountNumber: account_number,
              beneficiaryName: account_name,
              beneficiaryAccountNumber: account_number,
              beneficiaryBankCode: bank_code,
              beneficiaryBankName: bank_name || null,
              fee,
              transferFee: fee,
              vat,
              markup,
              totalDebited,
              transactionDate: new Date().toISOString(),
            }, { merge: true });
          } catch (fsError: any) {
            logger.error(`[TransferService] Firestore save failed for reference: ${reference} | error=${fsError.message}`);
          }
        }

        if (userId && userId !== "N/A") {
          try {
            await NotificationService.sendPushNotification(userId, {
              title: "Transfer To",
              body: `Transfer of ${currency} ₦${amount.toLocaleString(undefined, { minimumFractionDigits: 2 })} to ${account_name} was ${dbStatus === "success" ? "successful" : dbStatus === "failed" ? "failed" : "initiated"}.`,
              type: "transaction",
              reference,
              amount,
              currency,
              recipientName: account_name,
              bankName: bank_name || "",
            });
          } catch (notificationError: any) {
            logger.warn(`[TransferService] Transfer notification failed | reference=${reference} | error=${notificationError.message}`);
          }
        }

        const isProcessing = flwStatus === "new" || flwStatus === "pending";
        return {
          success: true,
          processing: isProcessing,
          reference,
          provider_reference: flwId,
          status: dbStatus,
          flutterwaveStatus: flwStatus,
          message: response.message || "Transfer initiated successfully.",
        };
      }

      // Provider explicitly rejected the request -> Roll back local debit if executed in this method
      if (localDebitPerformed && adminDb && userId && userId !== "N/A") {
        const db = adminDb;
        try {
          const userRef = db.collection("users").doc(userId);
          const walletRef = db.collection("wallets").doc(`${userId}_${currency || "NGN"}`);
          await db.runTransaction(async (rollbackTx) => {
            rollbackTx.update(userRef, {
              balance: FieldValue.increment(totalDebited),
              updatedAt: new Date().toISOString(),
            });
            const wSnap = await rollbackTx.get(walletRef);
            if (wSnap.exists) {
              rollbackTx.update(walletRef, {
                balance: FieldValue.increment(totalDebited),
                updatedAt: new Date().toISOString(),
              });
            }
            const unifiedTxRef = db.collection("transactions").doc(`tx-${reference}`);
            rollbackTx.update(unifiedTxRef, { status: "FAILED" });
          });
          logger.info(`[TransferService] Successfully rolled back local wallet debit of ₦${totalDebited} for ref=${reference}`);
        } catch (rbErr: any) {
          logger.error(`[TransferService] Failed rolling back local wallet debit for ref=${reference}: ${rbErr.message}`);
        }
      }

      await (this.idempotencyProvider as any).saveReference(reference, "flutterwave", "failed");
      return {
        success: false,
        reference,
        status: "failed",
        message: response?.message || "The payment provider rejected the transfer request.",
      };
    } catch (error: any) {
      // On provider transport exception, if local debit was performed, roll back if failure is immediate
      if (localDebitPerformed && adminDb && userId && userId !== "N/A") {
        const db = adminDb;
        try {
          const userRef = db.collection("users").doc(userId);
          const walletRef = db.collection("wallets").doc(`${userId}_${currency || "NGN"}`);
          await db.runTransaction(async (rollbackTx) => {
            rollbackTx.update(userRef, {
              balance: FieldValue.increment(totalDebited),
              updatedAt: new Date().toISOString(),
            });
            const wSnap = await rollbackTx.get(walletRef);
            if (wSnap.exists) {
              rollbackTx.update(walletRef, {
                balance: FieldValue.increment(totalDebited),
                updatedAt: new Date().toISOString(),
              });
            }
            const unifiedTxRef = db.collection("transactions").doc(`tx-${reference}`);
            rollbackTx.update(unifiedTxRef, { status: "FAILED" });
          });
          logger.info(`[TransferService] Successfully rolled back local wallet debit on exception for ref=${reference}`);
        } catch (rbErr: any) {
          logger.error(`[TransferService] Failed rolling back local wallet debit on exception for ref=${reference}: ${rbErr.message}`);
        }
      }

      logger.error(
        `[TransferService] Provider/transport failure; keeping idempotency reservation | reference=${reference} | error=${error.message || "Unknown provider error"} | reqId=${requestId}`
      );

      return {
        success: false,
        reference,
        status: "failed",
        message: error.message || "Transfer failed. Please check your balance and try again.",
      };
    }
  }
}
