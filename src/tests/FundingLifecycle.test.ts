import { handleWebhook, verifyPayment, initializePayment } from "../controllers/flutterwaveController";
import { adminDb } from "../config/firebase";
import { parseUserIdFromTxRef } from "../utils/userIdParser";

jest.mock("../config/firebase", () => ({
  adminDb: {
    collection: jest.fn(),
    runTransaction: jest.fn(),
  },
}));

jest.mock("../config/env", () => ({
  env: {
    FLW_WEBHOOK_SECRET: "test-secret-hash",
    FLW_SECRET_KEY: "FLWSECK_TEST",
    FLW_PUBLIC_KEY: "FLWPUBK_TEST",
  },
}));

jest.mock("../providers/flutterwave", () => ({
  getFlutterwaveClient: jest.fn().mockReturnValue({
    request: jest.fn().mockResolvedValue({
      status: "success",
      data: { link: "https://checkout.flutterwave.com/v3/hosted/pay/testlink" },
    }),
    verifyWebhookSignature: jest.fn().mockReturnValue(true),
  }),
}));

jest.mock("../services/paymentVerificationService", () => ({
  PaymentVerificationService: {
    verifyTransaction: jest.fn().mockResolvedValue({
      success: true,
      status: "successful",
      amount: 5000,
      currency: "NGN",
      reference: "flw-tx-user-123-100",
      flw_id: "998877",
      customer: { email: "user@example.com" },
    }),
    verifyTransactionByReference: jest.fn().mockResolvedValue({
      success: true,
      status: "successful",
      amount: 5000,
      currency: "NGN",
      reference: "flw-tx-user-123-100",
      flw_id: "998877",
      customer: { email: "user@example.com" },
    }),
  },
}));

jest.mock("../services/firestoreIdempotency", () => ({
  FirestoreIdempotency: {
    getInstance: jest.fn().mockReturnValue({
      isWebhookDuplicate: jest.fn().mockResolvedValue(false),
      saveWebhookProcessed: jest.fn().mockResolvedValue(undefined),
    }),
  },
}));

describe("Comprehensive Wallet Funding Lifecycle Tests", () => {
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

  // Test 1
  test("Test 1: Card initialize creates tx-FUNDING-* with status=PENDING, totalCredited=0, credited=false", async () => {
    const mockSet = jest.fn().mockResolvedValue({});
    const mockDoc = jest.fn().mockReturnValue({ set: mockSet });
    (adminDb!.collection as jest.Mock).mockImplementation((coll: string) => {
      return { doc: mockDoc };
    });

    req = {
      requestId: "test-req-1",
      body: {
        amount: 5000,
        currency: "NGN",
        email: "user@example.com",
        name: "Test User",
        userId: "user-123",
        redirectUrl: "https://example.com/callback",
      },
    };

    await initializePayment(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-123",
        amount: 5000,
        status: "PENDING",
        fundingMethod: "CARD",
        totalCredited: 0,
        credited: false,
      }),
      { merge: true }
    );
  });

  // Test 2
  test("Test 2: Successful Card webhook changes the SAME record to SUCCESS, credited=true, totalCredited=amount and credits wallet once", async () => {
    const mockUserDoc = { exists: true, data: () => ({ balance: 1000 }) };
    const mockWalletDoc = { exists: true, data: () => ({ balance: 1000 }) };
    const mockLedgerDoc = { exists: true, data: () => ({ status: "PENDING", credited: false }) };

    const mockUserRef = { id: "user-123" };
    const mockWalletRef = { id: "user-123_NGN" };
    const mockLedgerRef = { id: "tx-FUNDING-flw-tx-user-123-100" };

    (adminDb!.collection as jest.Mock).mockImplementation((coll: string) => {
      if (coll === "users") return { doc: () => mockUserRef };
      if (coll === "wallets") return { doc: () => mockWalletRef };
      if (coll === "transactions") return { doc: () => mockLedgerRef };
      return { doc: () => ({}) };
    });

    let userUpdatePayload: any = null;
    let ledgerSetPayload: any = null;

    (adminDb!.runTransaction as jest.Mock).mockImplementation(async (cb: any) => {
      const mockT = {
        get: jest.fn().mockImplementation((ref: any) => {
          if (ref === mockUserRef) return Promise.resolve(mockUserDoc);
          if (ref === mockWalletRef) return Promise.resolve(mockWalletDoc);
          if (ref === mockLedgerRef) return Promise.resolve(mockLedgerDoc);
          return Promise.resolve({ exists: false });
        }),
        update: jest.fn().mockImplementation((ref: any, data: any) => {
          if (ref === mockUserRef) userUpdatePayload = data;
        }),
        set: jest.fn().mockImplementation((ref: any, data: any) => {
          if (ref === mockLedgerRef) ledgerSetPayload = data;
        }),
      };
      return await cb(mockT);
    });

    req = {
      requestId: "test-webhook-1",
      headers: { "verif-hash": "test-secret-hash" },
      body: {
        event: "charge.completed",
        data: {
          id: 998877,
          tx_ref: "flw-tx-user-123-100",
          amount: 5000,
          currency: "NGN",
          status: "successful",
          payment_type: "card",
          card: { last_4digits: "4321", issuer: "VISA" },
          customer: { email: "user@example.com" },
        },
      },
    };

    await handleWebhook(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(ledgerSetPayload).not.toBeNull();
    expect(ledgerSetPayload.status).toBe("SUCCESS");
    expect(ledgerSetPayload.credited).toBe(true);
    expect(ledgerSetPayload.totalCredited).toBe(5000);
    expect(ledgerSetPayload.fundingMethod).toBe("CARD");
    expect(ledgerSetPayload.maskedCardNumber).toBe("VISA •••• 4321");
    expect(userUpdatePayload).not.toBeNull();
  });

  // Test 3
  test("Test 3: Sending the SAME successful webhook twice results in wallet credit = amount, NOT amount * 2", async () => {
    let walletIncrementCount = 0;
    const mockUserDoc = { exists: true, data: () => ({ balance: 1000 }) };
    const mockWalletDoc = { exists: true, data: () => ({ balance: 1000 }) };

    const mockUserRef = { id: "user-123" };
    const mockWalletRef = { id: "user-123_NGN" };
    const mockLedgerRef = { id: "tx-FUNDING-flw-tx-user-123-100" };

    let ledgerState = { status: "PENDING", credited: false };

    (adminDb!.collection as jest.Mock).mockImplementation((coll: string) => {
      if (coll === "users") return { doc: () => mockUserRef };
      if (coll === "wallets") return { doc: () => mockWalletRef };
      if (coll === "transactions") return { doc: () => mockLedgerRef };
      return { doc: () => ({}) };
    });

    (adminDb!.runTransaction as jest.Mock).mockImplementation(async (cb: any) => {
      const mockT = {
        get: jest.fn().mockImplementation((ref: any) => {
          if (ref === mockUserRef) return Promise.resolve(mockUserDoc);
          if (ref === mockWalletRef) return Promise.resolve(mockWalletDoc);
          if (ref === mockLedgerRef) return Promise.resolve({ exists: true, data: () => ledgerState });
          return Promise.resolve({ exists: false });
        }),
        update: jest.fn().mockImplementation((ref: any) => {
          if (ref === mockUserRef) walletIncrementCount++;
        }),
        set: jest.fn().mockImplementation((ref: any, data: any) => {
          if (ref === mockLedgerRef) {
            ledgerState = { ...ledgerState, ...data };
          }
        }),
      };
      return await cb(mockT);
    });

    req = {
      requestId: "test-dup-1",
      headers: { "verif-hash": "test-secret-hash" },
      body: {
        event: "charge.completed",
        data: {
          id: 998877,
          tx_ref: "flw-tx-user-123-100",
          amount: 5000,
          currency: "NGN",
          status: "successful",
          customer: { email: "user@example.com" },
        },
      },
    };

    // First delivery
    await handleWebhook(req, res, next);
    // Duplicate delivery
    await handleWebhook(req, res, next);

    expect(walletIncrementCount).toBe(1);
    expect(ledgerState.status).toBe("SUCCESS");
    expect(ledgerState.credited).toBe(true);
  });

  // Test 4
  test("Test 4: Concurrent successful webhook + successful verification credits wallet exactly once", async () => {
    let walletIncrementCount = 0;
    const mockUserDoc = { exists: true, data: () => ({ balance: 1000 }) };
    const mockWalletDoc = { exists: true, data: () => ({ balance: 1000 }) };

    const mockUserRef = { id: "user-123" };
    const mockWalletRef = { id: "user-123_NGN" };
    const mockLedgerRef = { id: "tx-FUNDING-flw-tx-user-123-100" };

    let ledgerState = { status: "PENDING", credited: false };

    (adminDb!.collection as jest.Mock).mockImplementation((coll: string) => {
      if (coll === "users") return { doc: () => mockUserRef };
      if (coll === "wallets") return { doc: () => mockWalletRef };
      if (coll === "transactions") return { doc: () => mockLedgerRef };
      return { doc: () => ({}) };
    });

    let transactionQueue = Promise.resolve();
    (adminDb!.runTransaction as jest.Mock).mockImplementation((cb: any) => {
      const result = transactionQueue.then(async () => {
        const mockT = {
          get: jest.fn().mockImplementation((ref: any) => {
            if (ref === mockUserRef) return Promise.resolve(mockUserDoc);
            if (ref === mockWalletRef) return Promise.resolve(mockWalletDoc);
            if (ref === mockLedgerRef) return Promise.resolve({ exists: true, data: () => ledgerState });
            return Promise.resolve({ exists: false });
          }),
          update: jest.fn().mockImplementation((ref: any) => {
            if (ref === mockUserRef) walletIncrementCount++;
          }),
          set: jest.fn().mockImplementation((ref: any, data: any) => {
            if (ref === mockLedgerRef) {
              ledgerState = { ...ledgerState, ...data };
            }
          }),
        };
        return await cb(mockT);
      });
      transactionQueue = result.catch(() => {});
      return result;
    });

    const webhookReq: any = {
      requestId: "race-webhook",
      headers: { "verif-hash": "test-secret-hash" },
      body: {
        event: "charge.completed",
        data: {
          id: 998877,
          tx_ref: "flw-tx-user-123-100",
          amount: 5000,
          currency: "NGN",
          status: "successful",
          customer: { email: "user@example.com" },
        },
      },
    };

    const verifyReq: any = {
      requestId: "race-verify",
      query: { transaction_id: "998877" },
    };

    await Promise.all([
      handleWebhook(webhookReq, res, next),
      verifyPayment(verifyReq, res, next),
    ]);

    expect(walletIncrementCount).toBe(1);
    expect(ledgerState.status).toBe("SUCCESS");
    expect(ledgerState.credited).toBe(true);
  });

  // Test 5
  test("Test 5: Failed funding sets status=FAILED, totalCredited=0, credited=false and no wallet credit", async () => {
    const mockDocSnap = { exists: true, data: () => ({ status: "PENDING" }) };
    const mockFundingDocRef = {
      get: jest.fn().mockResolvedValue(mockDocSnap),
      set: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    };

    (adminDb!.collection as jest.Mock).mockImplementation((coll: string) => {
      if (coll === "transactions") return { doc: () => mockFundingDocRef };
      return { doc: () => ({}) };
    });

    req = {
      requestId: "test-webhook-failed",
      headers: { "verif-hash": "test-secret-hash" },
      body: {
        event: "charge.completed",
        data: {
          id: 998878,
          tx_ref: "flw-tx-user-123-200",
          amount: 2000,
          status: "failed",
          processor_response: "Declined by bank",
        },
      },
    };

    await handleWebhook(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockFundingDocRef.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "FAILED",
        totalCredited: 0,
        credited: false,
      }),
      { merge: true }
    );
  });

  // Test 6
  test("Test 6: Canceled funding sets status=CANCELED, totalCredited=0, credited=false and no wallet credit", async () => {
    const mockDocSnap = { exists: true, data: () => ({ status: "PENDING" }) };
    const mockFundingDocRef = {
      get: jest.fn().mockResolvedValue(mockDocSnap),
      set: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    };

    (adminDb!.collection as jest.Mock).mockImplementation((coll: string) => {
      if (coll === "transactions") return { doc: () => mockFundingDocRef };
      return { doc: () => ({}) };
    });

    req = {
      requestId: "test-webhook-canceled",
      headers: { "verif-hash": "test-secret-hash" },
      body: {
        event: "charge.completed",
        data: {
          id: 998879,
          tx_ref: "flw-tx-user-123-300",
          amount: 2000,
          status: "cancelled",
          processor_response: "User canceled transaction",
        },
      },
    };

    await handleWebhook(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockFundingDocRef.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "CANCELED",
        totalCredited: 0,
        credited: false,
      }),
      { merge: true }
    );
  });

  // Test 7
  test("Test 7: Expired funding sets status=EXPIRED, totalCredited=0, credited=false and no wallet credit", async () => {
    const mockDocSnap = { exists: true, data: () => ({ status: "PENDING" }) };
    const mockFundingDocRef = {
      get: jest.fn().mockResolvedValue(mockDocSnap),
      set: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    };

    (adminDb!.collection as jest.Mock).mockImplementation((coll: string) => {
      if (coll === "transactions") return { doc: () => mockFundingDocRef };
      return { doc: () => ({}) };
    });

    req = {
      requestId: "test-webhook-expired",
      headers: { "verif-hash": "test-secret-hash" },
      body: {
        event: "charge.completed",
        data: {
          id: 998880,
          tx_ref: "flw-tx-user-123-400",
          amount: 2000,
          status: "expired",
          processor_response: "Transaction session expired",
        },
      },
    };

    await handleWebhook(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockFundingDocRef.set).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "EXPIRED",
        totalCredited: 0,
        credited: false,
      }),
      { merge: true }
    );
  });

  // Test 8
  test("Test 8: tx_ref containing a hyphenated UID parses complete UID correctly", () => {
    const parsedHyphenUid = parseUserIdFromTxRef("flw-tx-user-123-abc-999999");
    expect(parsedHyphenUid).toBe("user-123-abc");

    const parsedWalletUid = parseUserIdFromTxRef("user-wallet-usr-custom-77");
    expect(parsedWalletUid).toBe("usr-custom-77");
  });

  // Test 9
  test("Test 9: Unresolved/ambiguous user ID does NOT credit any wallet", async () => {
    let walletUpdated = false;
    const mockSet = jest.fn().mockResolvedValue({});
    const mockDoc = jest.fn().mockReturnValue({ set: mockSet });
    const mockQuery = { get: jest.fn().mockResolvedValue({ empty: true, docs: [] }) };

    (adminDb!.collection as jest.Mock).mockImplementation((coll: string) => {
      if (coll === "users") return { where: () => mockQuery };
      return { doc: mockDoc };
    });

    (adminDb!.runTransaction as jest.Mock).mockImplementation(async (cb: any) => {
      walletUpdated = true;
      return await cb({});
    });

    req = {
      requestId: "test-unmatched",
      headers: { "verif-hash": "test-secret-hash" },
      body: {
        event: "charge.completed",
        data: {
          id: 998881,
          tx_ref: "ambiguous-reference-code",
          amount: 10000,
          status: "successful",
          customer: { email: "nonexistent@example.com" },
        },
      },
    };

    await handleWebhook(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(walletUpdated).toBe(false);
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "PENDING",
        totalCredited: 0,
        unmatched: true,
      }),
      { merge: true }
    );
  });

  // Test 10
  test("Test 10: Confirm no Flutterwave wallet funding path creates duplicate tx-DEPOSIT-* ledger", async () => {
    const mockUserDoc = { exists: true, data: () => ({ balance: 1000 }) };
    const mockWalletDoc = { exists: true, data: () => ({ balance: 1000 }) };
    const mockLedgerDoc = { exists: true, data: () => ({ status: "PENDING" }) };

    const mockUserRef = { id: "user-123" };
    const mockWalletRef = { id: "user-123_NGN" };
    const mockLedgerRef = { id: "tx-FUNDING-flw-tx-user-123-100" };

    const createdDocIds: string[] = [];

    (adminDb!.collection as jest.Mock).mockImplementation((coll: string) => {
      if (coll === "transactions") {
        return {
          doc: (docId: string) => {
            createdDocIds.push(docId);
            return mockLedgerRef;
          },
        };
      }
      if (coll === "users") return { doc: () => mockUserRef };
      if (coll === "wallets") return { doc: () => mockWalletRef };
      return { doc: () => ({}) };
    });

    (adminDb!.runTransaction as jest.Mock).mockImplementation(async (cb: any) => {
      const mockT = {
        get: jest.fn().mockImplementation((ref: any) => {
          if (ref === mockUserRef) return Promise.resolve(mockUserDoc);
          if (ref === mockWalletRef) return Promise.resolve(mockWalletDoc);
          if (ref === mockLedgerRef) return Promise.resolve(mockLedgerDoc);
          return Promise.resolve({ exists: false });
        }),
        update: jest.fn(),
        set: jest.fn(),
      };
      return await cb(mockT);
    });

    req = {
      requestId: "test-no-deposit",
      headers: { "verif-hash": "test-secret-hash" },
      body: {
        event: "charge.completed",
        data: {
          id: 998877,
          tx_ref: "flw-tx-user-123-100",
          amount: 5000,
          currency: "NGN",
          status: "successful",
          customer: { email: "user@example.com" },
        },
      },
    };

    await handleWebhook(req, res, next);

    const hasDepositDoc = createdDocIds.some((id) => id.includes("DEPOSIT"));
    expect(hasDepositDoc).toBe(false);
  });
});
