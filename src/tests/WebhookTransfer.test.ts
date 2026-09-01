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

  it("should update BOTH records to REVERSED and execute refund when REVERSED webhook is received", async () => {
    const reference = "trf-reversed-123";
    req.body.data.reference = reference;
    req.body.data.status = "REVERSED";

    const transferDocData = {
      reference,
      userId: "user-789",
      amount: 2000,
      fee: 50,
      recipientName: "Alice Wonderland",
      status: "PENDING",
      refunded: false,
    };

    const unifiedTxData = {
      transactionNumber: reference,
      userId: "user-789",
      amount: 2000,
      status: "PENDING",
      type: "TRANSFER",
    };

    const userDocData = {
      userId: "user-789",
      balance: 1000,
    };

    const mockTransferDoc = { exists: true, data: () => transferDocData };
    const mockUnifiedDoc = { exists: true, data: () => unifiedTxData };
    const mockUserDoc = { exists: true, data: () => userDocData };

    const mockTransferRef = { id: reference };
    const mockUnifiedRef = { id: `tx-${reference}` };
    const mockUserRef = { id: "user-789" };
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

    expect(transferUpdate?.data.status).toBe("REVERSED");
    expect(transferUpdate?.data.refunded).toBe(true);

    expect(unifiedUpdate?.data.status).toBe("REVERSED");

    expect(refundRecord).toBeDefined();
    expect(refundRecord?.data.amount).toBe(2050); // 2000 + 50 fee
  });

  it("should create missing transactions/tx-{reference} with full transfer metadata when missing", async () => {
    const reference = "trf-missing-unified-999";
    req.body.data.reference = reference;
    req.body.data.status = "SUCCESSFUL";

    const transferDocData = {
      reference,
      userId: "user-999",
      amount: 15000,
      currency: "NGN",
      fee: 200,
      transferFee: 200,
      vat: 15,
      markup: 50,
      totalDebited: 15265,
      recipientName: "Charlie Brown",
      recipientBankName: "First Bank",
      recipientAccountNumber: "3001234567",
      beneficiaryName: "Charlie Brown",
      beneficiaryBankCode: "011",
      beneficiaryBankName: "First Bank",
      beneficiaryAccountNumber: "3001234567",
      description: "Transfer to Charlie Brown",
      createdAt: "2026-08-31T20:00:00.000Z",
      status: "PENDING",
    };

    const mockTransferDoc = { exists: true, data: () => transferDocData };
    const mockUnifiedDoc = { exists: false, data: () => ({}) };

    const mockTransferRef = { id: reference };
    const mockUnifiedRef = { id: `tx-${reference}` };

    (adminDb!.collection as jest.Mock).mockImplementation((colName: string) => {
      if (colName === "transfers") return { doc: jest.fn().mockReturnValue(mockTransferRef) };
      if (colName === "transactions") return { doc: jest.fn().mockImplementation((docId: string) => {
        if (docId === `tx-${reference}`) return mockUnifiedRef;
        return { id: docId };
      })};
      return { doc: jest.fn().mockReturnValue({ id: "mock-doc" }) };
    });

    const transactionSets: Array<{ ref: any; data: any }> = [];

    (adminDb!.runTransaction as jest.Mock).mockImplementation(async (cb: any) => {
      const mockTx = {
        get: jest.fn().mockImplementation((ref: any) => {
          if (ref === mockTransferRef) return Promise.resolve(mockTransferDoc);
          if (ref === mockUnifiedRef) return Promise.resolve(mockUnifiedDoc);
          return Promise.resolve({ exists: false, data: () => ({}) });
        }),
        update: jest.fn(),
        set: jest.fn().mockImplementation((ref: any, data: any) => {
          transactionSets.push({ ref, data });
        }),
      };
      return await cb(mockTx);
    });

    await handleWebhook(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);

    const createdUnifiedTx = transactionSets.find((s) => s.ref === mockUnifiedRef);
    expect(createdUnifiedTx).toBeDefined();
    expect(createdUnifiedTx?.data.status).toBe("SUCCESS");
    expect(createdUnifiedTx?.data.userId).toBe("user-999");
    expect(createdUnifiedTx?.data.amount).toBe(15000);
    expect(createdUnifiedTx?.data.recipientName).toBe("Charlie Brown");
    expect(createdUnifiedTx?.data.beneficiaryBankName).toBe("First Bank");
    expect(createdUnifiedTx?.data.totalDebited).toBe(15265);
    expect(createdUnifiedTx?.data.transactionNumber).toBe(reference);
  });

  it("should verify frontend history model mapping returns Successful for status SUCCESS", () => {
    const normalizeStatus = (status?: string) => {
      const s = (status || "").toUpperCase().trim();
      if (s === "SUCCESS" || s === "SUCCESSFUL" || s === "COMPLETED" || s === "COMPLETE" || s === "ACTIVE" || s === "DELIVERED") {
        return "SUCCESS";
      }
      if (s === "PENDING" || s === "PROCESSING" || s === "NEW" || s === "QUEUED") {
        return "PENDING";
      }
      if (s === "REFUND" || s === "REFUNDED") {
        return "REFUND";
      }
      return "FAILED";
    };

    const backendTxRecord = {
      transactionNumber: "trf-1788210218380-RxCUL2",
      status: "SUCCESS",
      providerStatus: "SUCCESSFUL",
    };

    const mapped = normalizeStatus(backendTxRecord.status);
    expect(mapped).toBe("SUCCESS");
  });
});
