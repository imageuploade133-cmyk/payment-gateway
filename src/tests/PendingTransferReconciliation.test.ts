import { ReconciliationService } from "../services/reconciliationService";
import { TransferService } from "../services/transferService";
import { getFlutterwaveClient } from "../providers/flutterwave";

// Mock Firebase Admin SDK
jest.mock("firebase-admin/app", () => ({
  getApps: jest.fn(() => []),
  initializeApp: jest.fn(),
  cert: jest.fn(),
}));

jest.mock("firebase-admin/firestore", () => {
  return {
    FieldValue: {
      increment: jest.fn((amount) => ({ operand: amount })),
    },
  };
});

let mockTransfers: Record<string, any> = {};
let mockUsers: Record<string, any> = {};
let mockLocks: Record<string, any> = {};
let mockTransactions: Record<string, any> = {};

let mockFlwResponseStatus = "PENDING";
let mockFlwResponseData: any[] = [];

jest.mock("../providers/flutterwave", () => ({
  getFlutterwaveClient: jest.fn(() => ({
    request: jest.fn(async (method: string, endpoint: string, payload?: any) => {
      if (endpoint.includes("/transfers?reference=")) {
        return {
          status: "success",
          data: mockFlwResponseData,
        };
      }
      return { status: "success", data: { id: 998877, status: "NEW" } };
    }),
  })),
}));

jest.mock("../config/firebase", () => {
  const getMockDoc = (collectionName: string, id: string) => {
    return {
      id,
      _collection: collectionName,
      get: jest.fn(async () => {
        let exists = false;
        let data = {};
        if (collectionName === "transfers" && mockTransfers[id]) {
          exists = true;
          data = mockTransfers[id];
        } else if (collectionName === "users" && mockUsers[id]) {
          exists = true;
          data = mockUsers[id];
        } else if (collectionName === "reconciliation_locks" && mockLocks[id]) {
          exists = true;
          data = mockLocks[id];
        } else if (collectionName === "transactions" && mockTransactions[id]) {
          exists = true;
          data = mockTransactions[id];
        }
        return {
          exists,
          id,
          data: () => data,
        };
      }),
      set: jest.fn(async (data: any) => {
        if (collectionName === "transfers") mockTransfers[id] = { ...mockTransfers[id], ...data };
        else if (collectionName === "users") mockUsers[id] = { ...mockUsers[id], ...data };
        else if (collectionName === "transactions") mockTransactions[id] = { ...mockTransactions[id], ...data };
        else if (collectionName === "reconciliation_locks") mockLocks[id] = data;
      }),
      update: jest.fn(async (data: any) => {
        if (collectionName === "transfers") mockTransfers[id] = { ...mockTransfers[id], ...data };
        else if (collectionName === "users") {
          if (data && "balance" in data && typeof data.balance === "object" && "operand" in data.balance) {
            mockUsers[id].balance = (mockUsers[id].balance || 0) + data.balance.operand;
          } else {
            mockUsers[id] = { ...mockUsers[id], ...data };
          }
        } else if (collectionName === "transactions") mockTransactions[id] = { ...mockTransactions[id], ...data };
      }),
      delete: jest.fn(async () => {
        delete mockLocks[id];
      }),
    };
  };

  const getMockCollection = (collectionName: string) => {
    return {
      doc: jest.fn((id: string) => getMockDoc(collectionName, id)),
      where: jest.fn(() => ({
        get: jest.fn(async () => {
          const list = Object.entries(mockTransfers)
            .filter(([_, v]) => v.status === "PENDING" || v.status === "EXPIRED")
            .map(([k]) => getMockDoc("transfers", k));
          return {
            empty: list.length === 0,
            size: list.length,
            docs: list,
          };
        }),
      })),
    };
  };

  const dbInstance = {
    collection: jest.fn((collectionName: string) => getMockCollection(collectionName)),
    runTransaction: jest.fn(async (callback: any) => {
      return await callback({
        get: jest.fn(async (docRef: any) => {
          const path = docRef.id;
          const collection = docRef._collection || "transfers";
          let exists = false;
          let data = {};
          if (collection === "transfers" && mockTransfers[path]) {
            exists = true;
            data = mockTransfers[path];
          } else if (collection === "users" && mockUsers[path]) {
            exists = true;
            data = mockUsers[path];
          } else if (collection === "transactions" && mockTransactions[path]) {
            exists = true;
            data = mockTransactions[path];
          } else if (collection === "reconciliation_locks" && mockLocks[path]) {
            exists = true;
            data = mockLocks[path];
          }
          return {
            exists,
            id: path,
            data: () => data,
          };
        }),
        set: jest.fn((docRef: any, data: any) => {
          const path = docRef.id;
          const collection = docRef._collection || "transfers";
          if (collection === "transfers") mockTransfers[path] = { ...mockTransfers[path], ...data };
          else if (collection === "transactions") mockTransactions[path] = { ...mockTransactions[path], ...data };
          else if (collection === "reconciliation_locks") mockLocks[path] = data;
        }),
        update: jest.fn((docRef: any, data: any) => {
          const path = docRef.id;
          const collection = docRef._collection || "transfers";
          if (collection === "transfers") mockTransfers[path] = { ...mockTransfers[path], ...data };
          else if (collection === "users") {
            if (data && "balance" in data && typeof data.balance === "object" && "operand" in data.balance) {
              mockUsers[path].balance = (mockUsers[path].balance || 0) + data.balance.operand;
            } else {
              mockUsers[path] = { ...mockUsers[path], ...data };
            }
          } else if (collection === "transactions") mockTransactions[path] = { ...mockTransactions[path], ...data };
        }),
      });
    }),
  };

  return {
    adminDb: dbInstance,
    initializeFirebaseAdmin: jest.fn(() => ({ hasCredentials: true, db: dbInstance })),
  };
});

describe("Pending Transfer Reconciliation & History Visibility Tests", () => {
  beforeEach(() => {
    mockTransfers = {};
    mockUsers = {};
    mockLocks = {};
    mockTransactions = {};
    mockFlwResponseData = [];
    jest.clearAllMocks();
  });

  it("1. Should keep transfers older than 24 hours in PENDING status without expiring them", async () => {
    const reference = "trf-old-pending-123";
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    mockTransfers[reference] = {
      reference,
      userId: "user-456",
      amount: 10000,
      fee: 25,
      status: "PENDING",
      createdAt: twoDaysAgo,
      expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    };

    mockTransactions[`tx-${reference}`] = {
      userId: "user-456",
      reference,
      status: "PENDING",
      createdAt: twoDaysAgo,
    };

    // Provider returns still pending
    mockFlwResponseData = [{ status: "NEW", id: 112233 }];

    const reconService = ReconciliationService.getInstance();
    const result = await reconService.reconcileSingleTransfer(reference);

    expect(result.success).toBe(true);
    expect(result.status).toBe("PENDING");
    expect(mockTransfers[reference].status).toBe("PENDING");
    expect(mockTransactions[`tx-${reference}`].status).toBe("PENDING");
  });

  it("2. Should ensure pending transfer documents store userId and createdAt for transaction history visibility", async () => {
    const reference = "trf-history-check-999";
    const transferService = new TransferService({
      isDuplicate: jest.fn().mockResolvedValue(false),
      saveReference: jest.fn().mockResolvedValue(undefined),
    } as any);

    mockUsers["user-789"] = { balance: 50000 };

    await transferService.executeTransfer({
      amount: 5000,
      account_number: "0123456789",
      bank_code: "044",
      account_name: "Test Recipient",
      currency: "NGN",
      narration: "Test Transfer",
      reference,
      requestId: "req-1",
      userId: "user-789",
      fee: 10,
    });

    const txDoc = mockTransactions[`tx-${reference}`];
    expect(txDoc).toBeDefined();
    expect(txDoc.userId).toBe("user-789");
    expect(txDoc.status).toBe("PENDING");
    expect(txDoc.createdAt).toBeDefined();
  });

  it("3. Should reject transfer initiation if userId is unauthenticated or missing", async () => {
    const transferService = new TransferService({
      isDuplicate: jest.fn().mockResolvedValue(false),
      saveReference: jest.fn().mockResolvedValue(undefined),
    } as any);

    const result = await transferService.executeTransfer({
      amount: 1000,
      account_number: "0123456789",
      bank_code: "044",
      account_name: "Test Recipient",
      currency: "NGN",
      narration: "Missing User ID",
      reference: "trf-no-user",
      requestId: "req-2",
      userId: "N/A",
    });

    expect(result.success).toBe(false);
    expect(result.message).toContain("userId is required");
  });

  it("4. Should update both transfers and transactions to SUCCESS when provider confirms eventual success", async () => {
    const reference = "trf-eventual-success-100";
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    mockTransfers[reference] = {
      reference,
      userId: "user-100",
      amount: 15000,
      fee: 25,
      status: "PENDING",
      createdAt: twoDaysAgo,
    };

    mockTransactions[`tx-${reference}`] = {
      userId: "user-100",
      reference,
      status: "PENDING",
      createdAt: twoDaysAgo,
    };

    // Provider confirms SUCCESSFUL
    mockFlwResponseData = [{ status: "SUCCESSFUL", id: 998811 }];

    const reconService = ReconciliationService.getInstance();
    const result = await reconService.reconcileSingleTransfer(reference);

    expect(result.success).toBe(true);
    expect(result.status).toBe("SUCCESS");
    expect(mockTransfers[reference].status).toBe("SUCCESS");
    expect(mockTransactions[`tx-${reference}`].status).toBe("SUCCESS");
  });

  it("5. Should update both transfers and transactions to FAILED and execute single atomic refund when provider confirms failure", async () => {
    const reference = "trf-eventual-failure-200";
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    mockTransfers[reference] = {
      reference,
      userId: "user-200",
      amount: 10000,
      fee: 25,
      totalDebited: 10025,
      status: "PENDING",
      createdAt: twoDaysAgo,
      refunded: false,
    };

    mockTransactions[`tx-${reference}`] = {
      userId: "user-200",
      reference,
      status: "PENDING",
      createdAt: twoDaysAgo,
    };

    mockUsers["user-200"] = { balance: 20000 };

    // Provider confirms FAILED
    mockFlwResponseData = [{ status: "FAILED", id: 998822, complete_message: "Account details invalid" }];

    const reconService = ReconciliationService.getInstance();
    const result1 = await reconService.reconcileSingleTransfer(reference);

    expect(result1.success).toBe(true);
    expect(result1.status).toBe("FAILED");
    expect(mockTransfers[reference].status).toBe("FAILED");
    expect(mockTransactions[`tx-${reference}`].status).toBe("FAILED");
    expect(mockTransfers[reference].refunded).toBe(true);
    expect(mockUsers["user-200"].balance).toBe(30025); // 20000 + 10025 refund

    // Idempotency check: running reconciliation again does not issue second refund
    const result2 = await reconService.reconcileSingleTransfer(reference);
    expect(result2.success).toBe(true);
    expect(mockUsers["user-200"].balance).toBe(30025); // balance stays unchanged
  });

  it("6. Should safely reconcile existing EXPIRED transfers with trustworthy provider identifiers without initiating new payouts", async () => {
    const reference = "trf-1791663087371-3HaWM2";
    mockTransfers[reference] = {
      reference,
      flutterwaveTransferId: "118053889",
      userId: "user-300",
      amount: 20000,
      fee: 25,
      totalDebited: 20025,
      status: "EXPIRED",
      refunded: false,
    };

    mockUsers["user-300"] = { balance: 5000 };

    // Provider confirms SUCCESSFUL for ID 118053889
    mockFlwResponseData = [{ status: "SUCCESSFUL", id: "118053889" }];

    const reconService = ReconciliationService.getInstance();
    const result = await reconService.reconcileSingleTransfer(reference);

    expect(result.success).toBe(true);
    expect(result.status).toBe("SUCCESS");
    expect(mockTransfers[reference].status).toBe("SUCCESS");
    expect(mockUsers["user-300"].balance).toBe(5000); // Balance unchanged because transfer succeeded
  });
});
