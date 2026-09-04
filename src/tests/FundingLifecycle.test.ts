import { handleWebhook, initializePayment } from "../controllers/flutterwaveController";
import { adminDb } from "../config/firebase";

jest.mock("../config/firebase", () => ({
  adminDb: {
    collection: jest.fn(),
    runTransaction: jest.fn(),
  },
}));

jest.mock("../config/env", () => ({
  env: {
    FLW_WEBHOOK_SECRET: "test-secret-hash",
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

  test("Card Funding: initialize payment creates pending tx-FUNDING- record", async () => {
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
      }),
      { merge: true }
    );
  });

  test("Card Funding: webhook charge.completed updates same tx-FUNDING- record to SUCCESS and credits wallet", async () => {
    const mockUserDoc = { exists: true, data: () => ({ balance: 1000 }) };
    const mockWalletDoc = { exists: true, data: () => ({ balance: 1000 }) };
    const mockLedgerDoc = { exists: true, data: () => ({ status: "PENDING" }) };

    const mockUserRef = { id: "user-123" };
    const mockWalletRef = { id: "user-123_NGN" };
    const mockLedgerRef = { id: "tx-FUNDING-flw-tx-user-123-100" };

    (adminDb!.collection as jest.Mock).mockImplementation((coll: string) => {
      if (coll === "users") return { doc: () => mockUserRef };
      if (coll === "wallets") return { doc: () => mockWalletRef };
      if (coll === "transactions") return { doc: () => mockLedgerRef };
      return { doc: () => ({}) };
    });

    let setPayload: any = null;
    (adminDb!.runTransaction as jest.Mock).mockImplementation(async (cb: any) => {
      const mockT = {
        get: jest.fn().mockImplementation((ref: any) => {
          if (ref === mockUserRef) return Promise.resolve(mockUserDoc);
          if (ref === mockWalletRef) return Promise.resolve(mockWalletDoc);
          if (ref === mockLedgerRef) return Promise.resolve(mockLedgerDoc);
          return Promise.resolve({ exists: false });
        }),
        update: jest.fn(),
        set: jest.fn().mockImplementation((ref: any, data: any) => {
          if (ref === mockLedgerRef) setPayload = data;
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
    expect(setPayload).not.toBeNull();
    expect(setPayload.status).toBe("SUCCESS");
    expect(setPayload.totalCredited).toBe(5000);
    expect(setPayload.fundingMethod).toBe("CARD");
    expect(setPayload.maskedCardNumber).toBe("VISA •••• 4321");
  });

  test("USSD Funding: webhook charge.completed FAILED updates tx-FUNDING- record to FAILED with totalCredited = 0", async () => {
    const mockDocSnap = { exists: true, data: () => ({ status: "PENDING" }) };
    const mockFundingDocRef = {
      get: jest.fn().mockResolvedValue(mockDocSnap),
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
          processor_response: "Insufficient funds",
        },
      },
    };

    await handleWebhook(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockFundingDocRef.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "FAILED",
        totalCredited: 0,
      })
    );
  });
});
