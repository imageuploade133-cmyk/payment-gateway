import { handleWebhook, verifyPayment } from "../controllers/flutterwaveController";
import { adminDb } from "../config/firebase";

jest.mock("../config/firebase", () => ({
  adminDb: {
    collection: jest.fn(),
    runTransaction: jest.fn(),
  },
}));

jest.mock("../providers/flutterwave", () => {
  const mClient = {
    request: jest.fn(),
    verifyWebhookSignature: jest.fn().mockReturnValue(true),
  };
  return {
    getFlutterwaveClient: () => mClient,
  };
});

jest.mock("../services/paymentVerificationService", () => ({
  PaymentVerificationService: {
    verifyTransaction: jest.fn().mockResolvedValue({
      status: "SUCCESSFUL",
      flw_id: "999888",
      reference: "flw-tx-user-conc-100",
      amount: 2500,
      currency: "NGN",
    }),
    verifyTransactionByReference: jest.fn().mockResolvedValue({
      status: "SUCCESSFUL",
      flw_id: "999888",
      reference: "flw-tx-user-conc-100",
      amount: 2500,
      currency: "NGN",
    }),
  },
}));

describe("Funding Concurrency & Expiration Security Tests", () => {
  let req: any;
  let res: any;
  let next: any;

  beforeEach(() => {
    jest.clearAllMocks();
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    next = jest.fn();
  });

  it("1. should never credit an EXPIRED funding transaction when verifyPayment is called", async () => {
    const mockUserDoc = { exists: true, data: () => ({ balance: 1000 }) };
    const mockWalletDoc = { exists: true, data: () => ({ balance: 1000 }) };
    const mockExpiredLedgerDoc = {
      exists: true,
      data: () => ({
        status: "EXPIRED",
        expiresAt: new Date(Date.now() - 60000).toISOString(),
        createdAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
      }),
    };

    const mockUserRef = { id: "user-conc" };
    const mockWalletRef = { id: "user-conc_NGN" };
    const mockLedgerRef = { id: "tx-FUNDING-flw-tx-user-conc-100" };

    (adminDb!.collection as jest.Mock).mockImplementation((coll: string) => {
      if (coll === "users") return { doc: () => mockUserRef };
      if (coll === "wallets") return { doc: () => mockWalletRef };
      if (coll === "transactions") return { doc: () => mockLedgerRef };
      return { doc: () => ({}) };
    });

    let transactionSetCalled = false;
    let transactionUpdateCalled = false;

    (adminDb!.runTransaction as jest.Mock).mockImplementation(async (cb: any) => {
      const mockT = {
        get: jest.fn().mockImplementation((ref: any) => {
          if (ref === mockUserRef) return Promise.resolve(mockUserDoc);
          if (ref === mockWalletRef) return Promise.resolve(mockWalletDoc);
          if (ref === mockLedgerRef) return Promise.resolve(mockExpiredLedgerDoc);
          return Promise.resolve({ exists: false });
        }),
        update: jest.fn().mockImplementation(() => {
          transactionUpdateCalled = true;
        }),
        set: jest.fn().mockImplementation((ref: any, data: any) => {
          if (ref === mockLedgerRef && data.unmatched) {
            transactionSetCalled = true;
          }
        }),
      };
      return await cb(mockT);
    });

    req = {
      requestId: "test-expired-verify",
      headers: {},
      query: {},
      body: {
        transaction_id: "999888",
        tx_ref: "flw-tx-user-conc-100",
      },
    };

    await verifyPayment(req as any, res, next);

    expect(transactionUpdateCalled).toBe(false);
    expect(transactionSetCalled).toBe(true);
  });

  it("2. should never credit an EXPIRED funding transaction when handleWebhook is called 1 second after expiry", async () => {
    const mockUserDoc = { exists: true, data: () => ({ balance: 1000 }) };
    const mockWalletDoc = { exists: true, data: () => ({ balance: 1000 }) };
    const mockExpiredLedgerDoc = {
      exists: true,
      data: () => ({
        status: "PENDING",
        expiresAt: new Date(Date.now() - 1000).toISOString(),
        createdAt: new Date(Date.now() - 11 * 60 * 1000 - 1000).toISOString(),
      }),
    };

    const mockUserRef = { id: "user-conc" };
    const mockWalletRef = { id: "user-conc_NGN" };
    const mockLedgerRef = { id: "tx-FUNDING-flw-tx-user-conc-100" };

    (adminDb!.collection as jest.Mock).mockImplementation((coll: string) => {
      if (coll === "users") return { doc: () => mockUserRef };
      if (coll === "wallets") return { doc: () => mockWalletRef };
      if (coll === "transactions") return { doc: () => mockLedgerRef };
      return { doc: () => ({}) };
    });

    let creditUpdated = false;
    let latePaymentFlagged = false;

    (adminDb!.runTransaction as jest.Mock).mockImplementation(async (cb: any) => {
      const mockT = {
        get: jest.fn().mockImplementation((ref: any) => {
          if (ref === mockUserRef) return Promise.resolve(mockUserDoc);
          if (ref === mockWalletRef) return Promise.resolve(mockWalletDoc);
          if (ref === mockLedgerRef) return Promise.resolve(mockExpiredLedgerDoc);
          return Promise.resolve({ exists: false });
        }),
        update: jest.fn().mockImplementation(() => {
          creditUpdated = true;
        }),
        set: jest.fn().mockImplementation((ref: any, data: any) => {
          if (ref === mockLedgerRef && data.status === "EXPIRED") {
            latePaymentFlagged = true;
          }
        }),
      };
      return await cb(mockT);
    });

    const webhookReq = {
      requestId: "test-expired-webhook",
      headers: { "verif-hash": "valid-hash" },
      query: {},
      body: {
        event: "charge.completed",
        data: {
          id: 999888,
          tx_ref: "flw-tx-user-conc-100",
          amount: 2500,
          status: "successful",
          customer: { email: "user@example.com" },
        },
      },
    };

    await handleWebhook(webhookReq as any, res, next);

    expect(creditUpdated).toBe(false);
    expect(latePaymentFlagged).toBe(true);
  });

  it("3. should enforce single credit during concurrent verifyPayment and handleWebhook calls", async () => {
    const mockUserDoc = { exists: true, data: () => ({ balance: 1000 }) };
    const mockWalletDoc = { exists: true, data: () => ({ balance: 1000 }) };
    
    let sharedLedgerState: any = {
      status: "PENDING",
      credited: false,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    };

    const mockUserRef = { id: "user-conc" };
    const mockWalletRef = { id: "user-conc_NGN" };
    const mockLedgerRef = { id: "tx-FUNDING-flw-tx-user-conc-100" };

    (adminDb!.collection as jest.Mock).mockImplementation((coll: string) => {
      if (coll === "users") return { doc: () => mockUserRef };
      if (coll === "wallets") return { doc: () => mockWalletRef };
      if (coll === "transactions") return { doc: () => mockLedgerRef };
      return { doc: () => ({}) };
    });

    let creditIncrementCount = 0;

    (adminDb!.runTransaction as jest.Mock).mockImplementation(async (cb: any) => {
      const mockT = {
        get: jest.fn().mockImplementation((ref: any) => {
          if (ref === mockUserRef) return Promise.resolve(mockUserDoc);
          if (ref === mockWalletRef) return Promise.resolve(mockWalletDoc);
          if (ref === mockLedgerRef) {
            return Promise.resolve({
              exists: true,
              data: () => sharedLedgerState,
            });
          }
          return Promise.resolve({ exists: false });
        }),
        update: jest.fn().mockImplementation((ref: any) => {
          if (ref === mockUserRef || ref === mockWalletRef) {
            creditIncrementCount++;
          }
        }),
        set: jest.fn().mockImplementation((ref: any, data: any) => {
          if (ref === mockLedgerRef) {
            sharedLedgerState = {
              ...sharedLedgerState,
              ...data,
            };
          }
        }),
      };
      return await cb(mockT);
    });

    const verifyReq = {
      requestId: "test-conc-verify",
      headers: {},
      query: {},
      body: { transaction_id: "999888", tx_ref: "flw-tx-user-conc-100" },
    };

    const webhookReq = {
      requestId: "test-conc-webhook",
      headers: { "verif-hash": "valid-hash" },
      query: {},
      body: {
        event: "charge.completed",
        data: {
          id: 999888,
          tx_ref: "flw-tx-user-conc-100",
          amount: 2500,
          status: "successful",
          customer: { email: "user@example.com" },
        },
      },
    };

    await Promise.all([
      verifyPayment(verifyReq as any, res, next),
      handleWebhook(webhookReq as any, res, next),
    ]);

    expect(creditIncrementCount).toBe(2);
    expect(sharedLedgerState.status).toBe("SUCCESS");
    expect(sharedLedgerState.credited).toBe(true);
  });

  it("4. should allow webhook retry when initial Firestore transaction fails transiently", async () => {
    const mockUserDoc = { exists: true, data: () => ({ balance: 1000 }) };
    const mockWalletDoc = { exists: true, data: () => ({ balance: 1000 }) };
    
    let sharedLedgerState: any = {
      status: "PENDING",
      credited: false,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    };

    const mockUserRef = { id: "user-conc" };
    const mockWalletRef = { id: "user-conc_NGN" };
    const mockLedgerRef = { id: "tx-FUNDING-flw-tx-user-retry-100" };

    (adminDb!.collection as jest.Mock).mockImplementation((coll: string) => {
      if (coll === "users") return { doc: () => mockUserRef };
      if (coll === "wallets") return { doc: () => mockWalletRef };
      if (coll === "transactions") return { doc: () => mockLedgerRef };
      return { doc: () => ({}) };
    });

    let attemptCount = 0;

    (adminDb!.runTransaction as jest.Mock).mockImplementation(async (cb: any) => {
      attemptCount++;
      if (attemptCount === 1) {
        throw new Error("Transient Firestore connection timeout");
      }
      const mockT = {
        get: jest.fn().mockImplementation((ref: any) => {
          if (ref === mockUserRef) return Promise.resolve(mockUserDoc);
          if (ref === mockWalletRef) return Promise.resolve(mockWalletDoc);
          if (ref === mockLedgerRef) {
            return Promise.resolve({
              exists: true,
              data: () => sharedLedgerState,
            });
          }
          return Promise.resolve({ exists: false });
        }),
        update: jest.fn(),
        set: jest.fn().mockImplementation((ref: any, data: any) => {
          if (ref === mockLedgerRef) {
            sharedLedgerState = { ...sharedLedgerState, ...data };
          }
        }),
      };
      return await cb(mockT);
    });

    const webhookReq = {
      requestId: "test-retry-webhook",
      headers: { "verif-hash": "valid-hash" },
      query: {},
      body: {
        event: "charge.completed",
        data: {
          id: "flw-retry-id-100",
          tx_ref: "flw-tx-user-retry-100",
          amount: 5000,
          status: "successful",
          customer: { email: "user@example.com" },
        },
      },
    };

    // First attempt fails transiently
    await handleWebhook(webhookReq as any, res, next);
    expect(sharedLedgerState.credited).toBe(false);

    // Provider retries webhook
    await handleWebhook(webhookReq as any, res, next);
    expect(sharedLedgerState.credited).toBe(true);
    expect(sharedLedgerState.status).toBe("SUCCESS");
  });
});
