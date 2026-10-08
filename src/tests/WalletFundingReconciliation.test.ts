import { WalletFundingService, resolveUserIdSafely } from "../services/walletFundingService";
import { ReconciliationService } from "../services/reconciliationService";
import { PaymentVerificationService } from "../services/paymentVerificationService";
import { FirestoreIdempotency } from "../services/firestoreIdempotency";
import { parseUserIdFromTxRef, isValidFlwId, resolveFundingLedgerDocId } from "../utils/userIdParser";

// Mock Stores
const mockUserStore: Record<string, any> = {
  "user-123": { balance: 1000, outstandingDebt: 0, email: "john@example.com" },
  "user-indebted": { balance: 500, outstandingDebt: 200, email: "indebted@example.com" }
};

const mockWalletStore: Record<string, any> = {
  "user-123_NGN": { userId: "user-123", balance: 1000, currency: "NGN" },
  "user-indebted_NGN": { userId: "user-indebted", balance: 500, currency: "NGN" }
};

const mockWalletAccountStore: Record<string, any> = {
  "wa-1": { userId: "user-123", accountNumber: "0123456789" },
  "wa-duplicate-1": { userId: "user-123", accountNumber: "9999999999" },
  "wa-duplicate-2": { userId: "user-456", accountNumber: "9999999999" }
};

const mockTransactionStore: Record<string, any> = {};
const mockWebhookStore: Record<string, any> = {};

function applyFieldValueUpdates(target: Record<string, any>, updates: Record<string, any>) {
  for (const [key, value] of Object.entries(updates)) {
    if (value && typeof value === "object" && "operand" in value) {
      const curr = Number(target[key]) || 0;
      target[key] = curr + Number(value.operand);
    } else {
      target[key] = value;
    }
  }
}

let transactionLock = false;

jest.mock("../config/firebase", () => {
  const getMockDocSnap = (store: Record<string, any>, key: string) => {
    const data = store[key];
    return {
      exists: !!data,
      id: key,
      data: () => (data ? JSON.parse(JSON.stringify(data)) : undefined),
    };
  };

  const createQuery = (colName: string, filters: Array<{ field: string; val: any }> = []) => {
    return {
      where: (field: string, op: string, val: any) => {
        return createQuery(colName, [...filters, { field, val }]);
      },
      limit: (n: number) => ({
        get: async () => {
          const store = colName === "wallet_accounts"
            ? mockWalletAccountStore
            : colName === "users"
            ? mockUserStore
            : colName === "gateway_processed_webhooks"
            ? mockWebhookStore
            : mockTransactionStore;
          const docs = Object.entries(store)
            .filter(([id, data]) => filters.every(f => data[f.field] === f.val))
            .slice(0, n)
            .map(([id, data]) => ({
              id,
              data: () => ({ ...data }),
            }));
          return {
            empty: docs.length === 0,
            size: docs.length,
            docs,
          };
        }
      }),
      get: async () => {
        const store = colName === "wallet_accounts"
          ? mockWalletAccountStore
          : colName === "users"
          ? mockUserStore
          : colName === "gateway_processed_webhooks"
          ? mockWebhookStore
          : mockTransactionStore;
        const docs = Object.entries(store)
          .filter(([id, data]) => filters.every(f => data[f.field] === f.val))
          .map(([id, data]) => ({
            id,
            data: () => ({ ...data }),
          }));
        return {
          empty: docs.length === 0,
          size: docs.length,
          docs,
        };
      }
    };
  };

  return {
    adminDb: {
      collection: (colName: string) => ({
        doc: (docId: string) => ({
          get: async () => {
            if (colName === "users") return getMockDocSnap(mockUserStore, docId);
            if (colName === "wallets") return getMockDocSnap(mockWalletStore, docId);
            if (colName === "wallet_accounts") return getMockDocSnap(mockWalletAccountStore, docId);
            if (colName === "gateway_processed_webhooks") return getMockDocSnap(mockWebhookStore, docId);
            if (colName === "transactions") return getMockDocSnap(mockTransactionStore, docId);
            return { exists: false, id: docId, data: () => undefined };
          },
          set: async (data: any, opts?: any) => {
            const store = colName === "gateway_processed_webhooks" ? mockWebhookStore : mockTransactionStore;
            if (opts?.merge && store[docId]) {
              applyFieldValueUpdates(store[docId], data);
            } else {
              store[docId] = {};
              applyFieldValueUpdates(store[docId], data);
            }
          },
          update: async (data: any) => {
            if (colName === "users" && mockUserStore[docId]) {
              applyFieldValueUpdates(mockUserStore[docId], data);
            }
            if (colName === "wallets" && mockWalletStore[docId]) {
              applyFieldValueUpdates(mockWalletStore[docId], data);
            }
            if (colName === "gateway_processed_webhooks" && mockWebhookStore[docId]) {
              applyFieldValueUpdates(mockWebhookStore[docId], data);
            }
            if (colName === "transactions" && mockTransactionStore[docId]) {
              applyFieldValueUpdates(mockTransactionStore[docId], data);
            }
          }
        }),
        where: (field: string, op: string, val: any) => {
          return createQuery(colName, [{ field, val }]);
        }
      }),
      runTransaction: async (updateFunction: (transaction: any) => Promise<any>) => {
        while (transactionLock) {
          await new Promise((r) => setTimeout(r, 5));
        }
        transactionLock = true;
        try {
          const transaction = {
            get: async (ref: any) => ref.get(),
            set: (ref: any, data: any, opts?: any) => ref.set(data, opts),
            create: (ref: any, data: any) => ref.set(data),
            update: (ref: any, data: any) => ref.update(data),
          };
          const res = await updateFunction(transaction);
          return res;
        } finally {
          transactionLock = false;
        }
      }
    }
  };
});

jest.mock("../services/notificationService", () => ({
  NotificationService: {
    sendPushNotification: jest.fn().mockResolvedValue(true)
  }
}));

jest.mock("../services/paymentVerificationService", () => ({
  PaymentVerificationService: {
    verifyTransaction: jest.fn(),
    verifyTransactionByReference: jest.fn()
  }
}));

describe("Wallet Funding, Reconciliation & User Resolution Master Security Suite", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUserStore["user-123"] = { balance: 1000, outstandingDebt: 0, email: "john@example.com" };
    mockWalletStore["user-123_NGN"] = { userId: "user-123", balance: 1000, currency: "NGN" };
    mockUserStore["user-indebted"] = { balance: 500, outstandingDebt: 200, email: "indebted@example.com" };
    mockWalletStore["user-indebted_NGN"] = { userId: "user-indebted", balance: 500, currency: "NGN" };

    Object.keys(mockTransactionStore).forEach((k) => delete mockTransactionStore[k]);
    Object.keys(mockWebhookStore).forEach((k) => delete mockWebhookStore[k]);
  });

  test("1. Successful webhook/direct credit updates user balance and marks transaction credited", async () => {
    const res = await WalletFundingService.executeAtomicWalletCredit({
      flwId: "990001",
      txRef: "user-wallet-user-123",
      amount: 5000,
      currency: "NGN",
      source: "webhook"
    });

    expect(res.success).toBe(true);
    expect(res.credited).toBe(true);
    expect(res.alreadyCredited).toBe(false);
    expect(res.totalCredited).toBe(5000);
    expect(res.newBalance).toBe(6000);
    expect(mockUserStore["user-123"].balance).toBe(6000);

    const docId = resolveFundingLedgerDocId("user-wallet-user-123", "990001");
    expect(mockTransactionStore[docId].status).toBe("SUCCESS");
    expect(mockTransactionStore[docId].credited).toBe(true);
  });

  test("2. Successful reconciliation credits wallet when verification confirms payment success", async () => {
    (PaymentVerificationService.verifyTransaction as jest.Mock).mockResolvedValue({
      success: true,
      status: "successful",
      amount: 2500,
      currency: "NGN",
      reference: "user-wallet-user-123",
      flw_id: "990002",
      customer: { email: "john@example.com" }
    });

    mockTransactionStore["tx-FUNDING-flw-990002"] = {
      type: "WALLET_FUNDING",
      status: "PENDING",
      flwId: "990002",
      reference: "user-wallet-user-123",
      userId: "user-123"
    };

    await ReconciliationService.getInstance().reconcilePendingFundings();

    expect(mockUserStore["user-123"].balance).toBe(3500);
    expect(mockTransactionStore["tx-FUNDING-flw-990002"].status).toBe("SUCCESS");
  });

  test("3. Reconciliation actually inspects verification result and skips credit when provider status is not successful", async () => {
    (PaymentVerificationService.verifyTransaction as jest.Mock).mockResolvedValue({
      success: false,
      status: "pending",
      amount: 2500,
      currency: "NGN",
      reference: "user-wallet-user-123",
      flw_id: "990003"
    });

    mockTransactionStore["tx-FUNDING-flw-990003"] = {
      type: "WALLET_FUNDING",
      status: "PENDING",
      flwId: "990003",
      reference: "user-wallet-user-123",
      userId: "user-123"
    };

    await ReconciliationService.getInstance().reconcilePendingFundings();

    expect(mockUserStore["user-123"].balance).toBe(1000);
    expect(mockTransactionStore["tx-FUNDING-flw-990003"].status).toBe("PENDING");
  });

  test("4. Duplicate reconciliation call does not credit twice (idempotency)", async () => {
    const firstRes = await WalletFundingService.executeAtomicWalletCredit({
      flwId: "990004",
      txRef: "user-wallet-user-123",
      amount: 1000,
      currency: "NGN",
      source: "verify"
    });

    expect(firstRes.credited).toBe(true);
    expect(mockUserStore["user-123"].balance).toBe(2000);

    const secondRes = await WalletFundingService.executeAtomicWalletCredit({
      flwId: "990004",
      txRef: "user-wallet-user-123",
      amount: 1000,
      currency: "NGN",
      source: "reconciliation"
    });

    expect(secondRes.credited).toBe(false);
    expect(secondRes.alreadyCredited).toBe(true);
    expect(mockUserStore["user-123"].balance).toBe(2000);
  });

  test("5. Webhook + Reconciliation concurrency produces exactly ONE credit", async () => {
    const flwId = "990005";
    const txRef = "user-wallet-user-123";

    const p1 = WalletFundingService.executeAtomicWalletCredit({ flwId, txRef, amount: 1500, currency: "NGN", source: "webhook" });
    const p2 = WalletFundingService.executeAtomicWalletCredit({ flwId, txRef, amount: 1500, currency: "NGN", source: "reconciliation" });

    const [r1, r2] = await Promise.all([p1, p2]);
    const creditedCount = (r1.credited ? 1 : 0) + (r2.credited ? 1 : 0);
    expect(creditedCount).toBe(1);
    expect(mockUserStore["user-123"].balance).toBe(2500);
  });

  test("6. Failed verification result does not credit and marks transaction FAILED", async () => {
    (PaymentVerificationService.verifyTransaction as jest.Mock).mockResolvedValue({
      success: false,
      status: "failed",
      isTransient: false,
      amount: 3000,
      currency: "NGN",
      reference: "user-wallet-user-123",
      flw_id: "990006",
      message: "Card charge declined by issuing bank"
    });

    mockTransactionStore["tx-FUNDING-flw-990006"] = {
      type: "WALLET_FUNDING",
      status: "PENDING",
      flwId: "990006",
      reference: "user-wallet-user-123",
      userId: "user-123"
    };

    await ReconciliationService.getInstance().reconcilePendingFundings();

    expect(mockUserStore["user-123"].balance).toBe(1000);
    expect(mockTransactionStore["tx-FUNDING-flw-990006"].status).toBe("FAILED");
  });

  test("7. Invalid or missing flwId is refused and does not credit wallet", async () => {
    const res1 = await WalletFundingService.executeAtomicWalletCredit({ flwId: "undefined", txRef: "user-wallet-user-123", amount: 1000, currency: "NGN" });
    expect(res1.success).toBe(false);
    expect(res1.credited).toBe(false);

    const res2 = await WalletFundingService.executeAtomicWalletCredit({ flwId: "", txRef: "user-wallet-user-123", amount: 1000, currency: "NGN" });
    expect(res2.success).toBe(false);
    expect(res2.credited).toBe(false);
  });

  test("8. wallet_accounts.userId is preferred over document ID", async () => {
    const res = await resolveUserIdSafely({ account_number: "0123456789" }, "VA-WEMA-0123456789");
    expect(res.userId).toBe("user-123");
    expect(res.ambiguous).toBe(false);
  });

  test("9. Duplicate account ownership in wallet_accounts is treated as AMBIGUOUS and not credited", async () => {
    const res = await resolveUserIdSafely({ account_number: "9999999999" }, "VA-WEMA-9999999999");
    expect(res.userId).toBeNull();
    expect(res.ambiguous).toBe(true);

    const creditRes = await WalletFundingService.executeAtomicWalletCredit({
      flwId: "990009",
      txRef: "VA-WEMA-9999999999",
      amount: 5000,
      currency: "NGN",
      payloadData: { account_number: "9999999999" }
    });

    expect(creditRes.success).toBe(false);
    expect(creditRes.credited).toBe(false);
    expect(creditRes.unmatched).toBe(true);
    expect(creditRes.ambiguous).toBe(true);
  });

  test("10. Unmatched funding is not credited and flagged as unmatched", async () => {
    const creditRes = await WalletFundingService.executeAtomicWalletCredit({
      flwId: "990010",
      txRef: "VA-UNKNOWN-5555555555",
      amount: 5000,
      currency: "NGN",
      payloadData: { account_number: "5555555555", customer: { email: "unknown@example.com" } }
    });

    expect(creditRes.success).toBe(false);
    expect(creditRes.credited).toBe(false);
    expect(creditRes.unmatched).toBe(true);

    const docId = resolveFundingLedgerDocId("VA-UNKNOWN-5555555555", "990010");
    expect(mockTransactionStore[docId].unmatched).toBe(true);
  });

  test("11. Late successful funding is recovered and credited exactly once", async () => {
    mockTransactionStore["tx-FUNDING-flw-990011"] = {
      type: "WALLET_FUNDING",
      status: "EXPIRED",
      flwId: "990011",
      reference: "user-wallet-user-123",
      userId: "user-123",
      createdAt: new Date(Date.now() - 3600 * 1000).toISOString()
    };

    const res = await WalletFundingService.executeAtomicWalletCredit({
      flwId: "990011",
      txRef: "user-wallet-user-123",
      amount: 4000,
      currency: "NGN",
      source: "reconciliation"
    });

    expect(res.success).toBe(true);
    expect(res.credited).toBe(true);
    expect(mockUserStore["user-123"].balance).toBe(5000);
    expect(mockTransactionStore["tx-FUNDING-flw-990011"].status).toBe("SUCCESS");
    expect(mockTransactionStore["tx-FUNDING-flw-990011"].credited).toBe(true);
  });

  test("12. Canonical docId tx-FUNDING-flw-${flwId} is strictly preserved", async () => {
    const docId1 = resolveFundingLedgerDocId("user-wallet-user-123", "123456");
    expect(docId1).toBe("tx-FUNDING-flw-123456");

    const docId2 = resolveFundingLedgerDocId("tx-FUNDING-flw-123456", "123456");
    expect(docId2).toBe("tx-FUNDING-flw-123456");
  });

  test("13. Existing webhook behavior remains intact for charge.completed", async () => {
    const res = await WalletFundingService.executeAtomicWalletCredit({
      flwId: "990013",
      txRef: "user-wallet-user-123",
      amount: 1000,
      currency: "NGN",
      payloadData: {
        payment_type: "card",
        card: { issuer: "VISA", last_4digits: "4242" }
      },
      source: "webhook"
    });

    expect(res.success).toBe(true);
    expect(res.credited).toBe(true);
    const docId = resolveFundingLedgerDocId("user-wallet-user-123", "990013");
    expect(mockTransactionStore[docId].fundingMethod).toBe("CARD");
    expect(mockTransactionStore[docId].maskedCardNumber).toBe("VISA •••• 4242");
  });

  test("14. Outstanding debt recovery is automatically deducted during atomic credit", async () => {
    const res = await WalletFundingService.executeAtomicWalletCredit({
      flwId: "990014",
      txRef: "user-wallet-user-indebted",
      amount: 1000,
      currency: "NGN",
      explicitUserId: "user-indebted",
      source: "verify"
    });

    expect(res.success).toBe(true);
    expect(res.credited).toBe(true);
    expect(mockUserStore["user-indebted"].balance).toBe(1300);
    expect(mockUserStore["user-indebted"].outstandingDebt).toBe(0);
  });

  test("15. Existing transfer and VTU reconciliation functions remain intact and operational", async () => {
    const reconciliation = ReconciliationService.getInstance();
    expect(typeof reconciliation.reconcileSingleTransfer).toBe("function");
    expect(typeof reconciliation.reconcileSingleVtuTransaction).toBe("function");
    expect(typeof reconciliation.reconcilePendingFundings).toBe("function");
  });

  test("16. EXPIRED record with NO flwId and NO trusted reference is SKIPPED (provider verification NOT called)", async () => {
    mockTransactionStore["tx-arbitrary-expired-999"] = {
      type: "WALLET_FUNDING",
      status: "EXPIRED",
      createdAt: new Date(Date.now() - 3600 * 1000).toISOString()
      // Notice: NO flwId, NO reference!
    };

    await ReconciliationService.getInstance().reconcilePendingFundings();

    expect(PaymentVerificationService.verifyTransaction).not.toHaveBeenCalledWith(
      expect.objectContaining({ transaction_id: "arbitrary-expired-999" })
    );
    expect(PaymentVerificationService.verifyTransactionByReference).not.toHaveBeenCalledWith(
      expect.objectContaining({ tx_ref: "arbitrary-expired-999" })
    );
  });

  test("17. EXPIRED record with INVALID or malformed flwId ('undefined', 'null', '0') is SKIPPED", async () => {
    mockTransactionStore["tx-FUNDING-flw-null"] = {
      type: "WALLET_FUNDING",
      status: "EXPIRED",
      flwId: "null",
      reference: "random-untrusted-ref",
      createdAt: new Date(Date.now() - 3600 * 1000).toISOString()
    };

    await ReconciliationService.getInstance().reconcilePendingFundings();

    expect(PaymentVerificationService.verifyTransaction).not.toHaveBeenCalledWith({
      transaction_id: "null",
      requestId: "reconcile-funding"
    });
  });

  test("18. EXPIRED record with TRUSTED reference is verified and recovered on successful provider response", async () => {
    (PaymentVerificationService.verifyTransactionByReference as jest.Mock).mockResolvedValue({
      success: true,
      status: "successful",
      amount: 6000,
      currency: "NGN",
      reference: "user-wallet-user-123",
      flw_id: "flw-late-trusted-888",
      customer: { email: "john@example.com" }
    });

    mockTransactionStore["tx-expired-trusted-888"] = {
      type: "WALLET_FUNDING",
      status: "EXPIRED",
      reference: "user-wallet-user-123",
      userId: "user-123",
      createdAt: new Date(Date.now() - 3600 * 1000).toISOString()
    };

    await ReconciliationService.getInstance().reconcilePendingFundings();

    expect(PaymentVerificationService.verifyTransactionByReference).toHaveBeenCalledWith({
      tx_ref: "user-wallet-user-123",
      requestId: "reconcile-funding"
    });

    expect(mockUserStore["user-123"].balance).toBe(7000); // 1000 + 6000
    expect(mockTransactionStore["tx-FUNDING-flw-flw-late-trusted-888"].status).toBe("SUCCESS");
  });

  test("19. EXPIRED record with failed provider status is NOT credited and remains uncredited", async () => {
    (PaymentVerificationService.verifyTransaction as jest.Mock).mockResolvedValue({
      success: false,
      status: "failed",
      isTransient: false,
      amount: 5000,
      currency: "NGN",
      reference: "user-wallet-user-123",
      flw_id: "expired-failed-777",
      message: "Insufficient funds on customer card"
    });

    mockTransactionStore["tx-FUNDING-flw-expired-failed-777"] = {
      type: "WALLET_FUNDING",
      status: "EXPIRED",
      flwId: "expired-failed-777",
      reference: "user-wallet-user-123",
      userId: "user-123",
      createdAt: new Date(Date.now() - 3600 * 1000).toISOString()
    };

    await ReconciliationService.getInstance().reconcilePendingFundings();

    expect(mockUserStore["user-123"].balance).toBe(1000); // Unchanged
    expect(mockTransactionStore["tx-FUNDING-flw-expired-failed-777"].status).toBe("EXPIRED"); // Stays EXPIRED
  });

  test("20. EXPIRED record with transient provider error remains EXPIRED and recoverable for future scans", async () => {
    (PaymentVerificationService.verifyTransaction as jest.Mock).mockResolvedValue({
      success: false,
      status: "pending",
      isTransient: true,
      amount: 0,
      currency: "NGN",
      reference: "user-wallet-user-123",
      flw_id: "expired-transient-555",
      message: "Temporary verification error: Provider socket timeout"
    });

    mockTransactionStore["tx-FUNDING-flw-expired-transient-555"] = {
      type: "WALLET_FUNDING",
      status: "EXPIRED",
      flwId: "expired-transient-555",
      reference: "user-wallet-user-123",
      userId: "user-123",
      createdAt: new Date(Date.now() - 3600 * 1000).toISOString()
    };

    await ReconciliationService.getInstance().reconcilePendingFundings();

    expect(mockUserStore["user-123"].balance).toBe(1000); // Unchanged
    expect(mockTransactionStore["tx-FUNDING-flw-expired-transient-555"].status).toBe("EXPIRED"); // Stays EXPIRED
  });
});
