import { handleWebhook } from "../controllers/flutterwaveController";
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

jest.mock("../services/firestoreIdempotency", () => ({
  FirestoreIdempotency: {
    getInstance: jest.fn().mockReturnValue({
      isWebhookDuplicate: jest.fn().mockResolvedValue(false),
      saveWebhookProcessed: jest.fn().mockResolvedValue(undefined),
      saveReference: jest.fn().mockResolvedValue(undefined),
    }),
  },
}));

describe("Webhook Transfer Synchronization & Reconciliation Tests", () => {
  let req: any;
  let res: any;
  let next: any;

  beforeEach(() => {
    jest.clearAllMocks();
    req = {
      requestId: "test-req-id",
      headers: {
        "verif-hash": "test-secret-hash",
      },
      body: {
        event: "transfer.completed",
        data: {
          id: 116653710,
          reference: "trf-1788210218380-RxCUL2",
          status: "SUCCESSFUL",
          amount: 5000,
          fee: 100,
          currency: "NGN",
        },
      },
    };

    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    next = jest.fn();
  });

  it("should update BOTH transfers and transactions/tx-{reference} documents to SUCCESS on SUCCESSFUL webhook", async () => {
    const reference = "trf-1788210218380-RxCUL2";
    const transferDocData = {
      reference,
      userId: "user-123",
      amount: 5000,
      fee: 100,
      recipientName: "Jane Doe",
      status: "PENDING",
    };

    const unifiedTxData = {
      transactionNumber: reference,
      userId: "user-123",
      amount: 5000,
      status: "PENDING",
      type: "TRANSFER",
      category: "transfer",
    };

    const mockTransferDoc = {
      exists: true,
      data: () => transferDocData,
    };

    const mockUnifiedDoc = {
      exists: true,
      data: () => unifiedTxData,
    };

    const mockTransferRef = { id: reference };
    const mockUnifiedRef = { id: `tx-${reference}` };

    (adminDb!.collection as jest.Mock).mockImplementation((colName: string) => {
      if (colName === "transfers") {
        return { doc: jest.fn().mockReturnValue(mockTransferRef) };
      }
      if (colName === "transactions") {
        return { doc: jest.fn().mockImplementation((docId: string) => {
          if (docId === `tx-${reference}`) return mockUnifiedRef;
          return { id: docId };
        })};
      }
      return { doc: jest.fn().mockReturnValue({ id: "mock-doc" }) };
    });

    const transactionUpdates: Array<{ ref: any; data: any }> = [];
    (adminDb!.runTransaction as jest.Mock).mockImplementation(async (cb: any) => {
      const mockTx = {
        get: jest.fn().mockImplementation((ref: any) => {
          if (ref === mockTransferRef) return Promise.resolve(mockTransferDoc);
          if (ref === mockUnifiedRef) return Promise.resolve(mockUnifiedDoc);
          return Promise.resolve({ exists: false, data: () => ({}) });
        }),
        update: jest.fn().mockImplementation((ref: any, data: any) => {
          transactionUpdates.push({ ref, data });
        }),
        set: jest.fn(),
      };
      return await cb(mockTx);
    });

    await handleWebhook(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);

    const transferUpdate = transactionUpdates.find((u) => u.ref === mockTransferRef);
    const unifiedUpdate = transactionUpdates.find((u) => u.ref === mockUnifiedRef);

    expect(transferUpdate).toBeDefined();
    expect(transferUpdate?.data.status).toBe("SUCCESS");
    expect(transferUpdate?.data.providerTransferId).toBe("116653710");

    expect(unifiedUpdate).toBeDefined();
    expect(unifiedUpdate?.data.status).toBe("SUCCESS");
    expect(unifiedUpdate?.data.providerTransactionId).toBe("116653710");
  });

  it("should repair a stale transactions/tx-{reference} status when transfers document is already SUCCESS", async () => {
    const reference = "trf-stale-test-123";
    req.body.data.reference = reference;
    req.body.data.status = "SUCCESSFUL";

    const transferDocData = {
      reference,
      userId: "user-123",
      amount: 5000,
      fee: 100,
      recipientName: "Jane Doe",
      status: "SUCCESS", // Already terminal
    };

    const unifiedTxData = {
      transactionNumber: reference,
      userId: "user-123",
      amount: 5000,
      status: "PENDING", // Stale
      type: "TRANSFER",
      category: "transfer",
    };

    const mockTransferDoc = {
      exists: true,
      data: () => transferDocData,
    };

    const mockUnifiedDoc = {
      exists: true,
      data: () => unifiedTxData,
    };

    const mockTransferRef = { id: reference };
    const mockUnifiedRef = { id: `tx-${reference}` };

    (adminDb!.collection as jest.Mock).mockImplementation((colName: string) => {
      if (colName === "transfers") {
        return { doc: jest.fn().mockReturnValue(mockTransferRef) };
      }
      if (colName === "transactions") {
        return { doc: jest.fn().mockImplementation((docId: string) => {
          if (docId === `tx-${reference}`) return mockUnifiedRef;
          return { id: docId };
        })};
      }
      return { doc: jest.fn().mockReturnValue({ id: "mock-doc" }) };
    });

    const transactionUpdates: Array<{ ref: any; data: any }> = [];
    (adminDb!.runTransaction as jest.Mock).mockImplementation(async (cb: any) => {
      const mockTx = {
        get: jest.fn().mockImplementation((ref: any) => {
          if (ref === mockTransferRef) return Promise.resolve(mockTransferDoc);
          if (ref === mockUnifiedRef) return Promise.resolve(mockUnifiedDoc);
          return Promise.resolve({ exists: false, data: () => ({}) });
        }),
        update: jest.fn().mockImplementation((ref: any, data: any) => {
          transactionUpdates.push({ ref, data });
        }),
        set: jest.fn(),
      };
      return await cb(mockTx);
    });

    await handleWebhook(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);

    const transferUpdate = transactionUpdates.find((u) => u.ref === mockTransferRef);
    const unifiedUpdate = transactionUpdates.find((u) => u.ref === mockUnifiedRef);

    expect(transferUpdate).toBeUndefined();
    expect(unifiedUpdate).toBeDefined();
    expect(unifiedUpdate?.data.status).toBe("SUCCESS");
  });

  it("should update BOTH records to FAILED and execute refund when FAILED webhook is received", async () => {
    const reference = "trf-failed-123";
    req.body.data.reference = reference;
    req.body.data.status = "FAILED";

    const transferDocData = {
      reference,
      userId: "user-456",
      amount: 10000,
      fee: 100,
      recipientName: "Bob Smith",
      status: "PENDING",
      refunded: false,
    };

    const unifiedTxData = {
      transactionNumber: reference,
      userId: "user-456",
      amount: 10000,
      status: "PENDING",
      type: "TRANSFER",
    };

    const userDocData = {
      userId: "user-456",
      balance: 5000,
    };

    const mockTransferDoc = { exists: true, data: () => transferDocData };
    const mockUnifiedDoc = { exists: true, data: () => unifiedTxData };
    const mockUserDoc = { exists: true, data: () => userDocData };

    const mockTransferRef = { id: reference };
    const mockUnifiedRef = { id: `tx-${reference}` };
    const mockUserRef = { id: "user-456" };
    const mockRefundRef = { id: `tx-REFUND-${reference}` };

    (adminDb!.collection as jest.Mock).mockImplementation((colName: string) => {
      if (colName === "transfers") return { doc: jest.fn().mockReturnValue(mockTransferRef) };
      if (colName === "transactions") return { doc: jest.fn().mockImplementation((docId: string) => {
        if (docId === `tx-${reference}`) return mockUnifiedRef;
        if (docId === `tx-REFUND-${reference}`) return mockRefundRef;
        return { id: docId };
      })};
      if (colName === "users") return { doc: jest.fn().mockReturnValue(mockUserRef) };
      return { doc: jest.fn().mockReturnValue({ id: "mock-doc" }) };
    });

    const transactionUpdates: Array<{ ref: any; data: any }> = [];
    const transactionSets: Array<{ ref: any; data: any }> = [];

    (adminDb!.runTransaction as jest.Mock).mockImplementation(async (cb: any) => {
      const mockTx = {
        get: jest.fn().mockImplementation((ref: any) => {
          if (ref === mockTransferRef) return Promise.resolve(mockTransferDoc);
          if (ref === mockUnifiedRef) return Promise.resolve(mockUnifiedDoc);
          if (ref === mockUserRef) return Promise.resolve(mockUserDoc);
          return Promise.resolve({ exists: false, data: () => ({}) });
        }),
        update: jest.fn().mockImplementation((ref: any, data: any) => {
          transactionUpdates.push({ ref, data });
        }),
        set: jest.fn().mockImplementation((ref: any, data: any) => {
          transactionSets.push({ ref, data });
        }),
      };
      return await cb(mockTx);
    });

    await handleWebhook(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);

    const transferUpdate = transactionUpdates.find((u) => u.ref === mockTransferRef);
    const unifiedUpdate = transactionUpdates.find((u) => u.ref === mockUnifiedRef);
    const refundRecord = transactionSets.find((s) => s.ref === mockRefundRef);

    expect(transferUpdate?.data.status).toBe("FAILED");
    expect(transferUpdate?.data.refunded).toBe(true);

    expect(unifiedUpdate?.data.status).toBe("FAILED");

    expect(refundRecord).toBeDefined();
    expect(refundRecord?.data.amount).toBe(10100); // 10000 + 100 fee
  });
});
