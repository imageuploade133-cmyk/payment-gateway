import { ReconciliationService } from "../services/reconciliationService";

// Mock Firebase Admin SDK
jest.mock("firebase-admin/app", () => ({
  getApps: jest.fn(() => []),
  initializeApp: jest.fn(),
  cert: jest.fn(),
}));

// Setup mock Firestore state
let mockTransfers: Record<string, any> = {};
let mockUsers: Record<string, any> = {};
let mockLocks: Record<string, any> = {};
let mockTransactions: Record<string, any> = {};

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
        }
        return {
          exists,
          id,
          data: () => data,
        };
      }),
      set: jest.fn(async (data: any, options?: any) => {
        if (collectionName === "reconciliation_locks") {
          mockLocks[id] = data;
        } else if (collectionName === "transfers") {
          mockTransfers[id] = { ...mockTransfers[id], ...data };
        } else if (collectionName === "users") {
          mockUsers[id] = { ...mockUsers[id], ...data };
        } else if (collectionName === "transactions") {
          mockTransactions[id] = data;
        }
      }),
      update: jest.fn(async (data: any) => {
        if (collectionName === "transfers") {
          mockTransfers[id] = { ...mockTransfers[id], ...data };
        } else if (collectionName === "users") {
          mockUsers[id] = { ...mockUsers[id], ...data };
        }
      }),
      delete: jest.fn(async () => {
        if (collectionName === "reconciliation_locks") {
          delete mockLocks[id];
        }
      }),
    };
  };

  const getMockCollection = (collectionName: string) => {
    return {
      doc: jest.fn((id: string) => getMockDoc(collectionName, id)),
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
          const collection = docRef._collection || "transactions";
          if (collection === "reconciliation_locks") {
            mockLocks[path] = data;
          } else if (collection === "transfers") {
            mockTransfers[path] = { ...mockTransfers[path], ...data };
          } else if (collection === "transactions") {
            mockTransactions[path] = data;
          }
        }),
        update: jest.fn((docRef: any, data: any) => {
          const path = docRef.id;
          const collection = docRef._collection || "transfers";
          if (collection === "transfers") {
            mockTransfers[path] = { ...mockTransfers[path], ...data };
          } else if (collection === "users") {
            if (data && "balance" in data) {
              mockUsers[path].balance = data.balance;
            } else {
              mockUsers[path] = { ...mockUsers[path], ...data };
            }
          }
        }),
      });
    }),
  };

  return {
    adminDb: dbInstance,
    initializeFirebaseAdmin: jest.fn(() => ({ hasCredentials: true, db: dbInstance })),
  };
});

// Mock Flutterwave Client and Logger
jest.mock("../providers/flutterwave", () => ({
  getFlutterwaveClient: jest.fn(() => ({
    request: jest.fn(async () => ({
      status: "success",
      data: [{ status: "FAILED", id: 12345, complete_message: "Failed" }],
    })),
  })),
}));

describe("Reconciliation Service Integration Tests", () => {
  beforeEach(() => {
    mockTransfers = {};
    mockUsers = {};
    mockLocks = {};
    mockTransactions = {};
  });

  it("should successfully refund a failed transfer atomically", async () => {
    const reference = "trf-1784838346726-RxCUL2";
    
    // Initial conditions requested:
    // Initial wallet balance = ₦10,000.
    // Failed transfer = ₦5,000 + ₦10 fee.
    mockTransfers[reference] = {
      userId: "C1vJGqceoGO57mVFYNM40URxCUL2",
      amount: 5000,
      fee: 10,
      status: "PENDING",
      refunded: false,
    };

    mockUsers["C1vJGqceoGO57mVFYNM40URxCUL2"] = {
      userId: "C1vJGqceoGO57mVFYNM40URxCUL2",
      balance: 10000,
    };

    const reconService = ReconciliationService.getInstance();

    // First reconciliation attempt
    const result1 = await reconService.reconcileSingleTransfer(reference);
    expect(result1.success).toBe(true);
    expect(result1.refunded).toBe(true);

    // Final wallet balance = ₦15,010.
    expect(mockUsers["C1vJGqceoGO57mVFYNM40URxCUL2"].balance).toBe(15010);
    expect(mockTransfers[reference].refunded).toBe(true);
    expect(mockTransfers[reference].refundProcessed).toBe(true);

    // Running reconciliation a second time does not issue another refund.
    const result2 = await reconService.reconcileSingleTransfer(reference);
    expect(result2.success).toBe(true);
    expect(result2.refunded).toBe(true); // skips and returns true for refund skipping

    // Balance remains exactly 15,010 (was not refunded twice!)
    expect(mockUsers["C1vJGqceoGO57mVFYNM40URxCUL2"].balance).toBe(15010);
  });
});
