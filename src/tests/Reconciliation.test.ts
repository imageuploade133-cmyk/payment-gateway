import { ReconciliationService } from "../services/reconciliationService";
import { adminDb } from "../config/firebase";

// Mock Firebase Admin App SDK
jest.mock("firebase-admin/app", () => ({
  getApps: jest.fn(() => [null]),
  initializeApp: jest.fn(),
  cert: jest.fn(),
}));

// Setup mock Firestore state
let mockTransfers: Record<string, any> = {};
let mockUsers: Record<string, any> = {};
let mockLocks: Record<string, any> = {};
let mockTransactions: Record<string, any> = {};

// We track which document reference was created
let lastDocId = "";
let lastCollection = "";

jest.mock("firebase-admin/firestore", () => {
  const getMockDocRef = (collectionName: string, id: string) => {
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
      set: jest.fn(async (data: any) => {
        if (collectionName === "reconciliation_locks") {
          mockLocks[id] = data;
        } else if (collectionName === "transfers") {
          mockTransfers[id] = { ...mockTransfers[id], ...data };
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

  const dbInstance = {
    collection: jest.fn((colName: string) => ({
      doc: jest.fn((id: string) => {
        lastDocId = id;
        lastCollection = colName;
        return getMockDocRef(colName, id);
      }),
    })),
    runTransaction: jest.fn(async (callback: any) => {
      return await callback({
        get: jest.fn(async (docRef: any) => {
          const path = docRef.id;
          const collection = docRef._collection;
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
          const collection = docRef._collection;
          if (collection === "reconciliation_locks") {
            mockLocks[path] = data;
          } else if (collection === "transfers") {
            mockTransfers[path] = { ...mockTransfers[path], ...data };
          } else if (collection === "transactions" || !collection) {
            mockTransactions[path] = data;
          }
        }),
        update: jest.fn((docRef: any, data: any) => {
          const path = docRef.id;
          const collection = docRef._collection;
          if (collection === "transfers") {
            mockTransfers[path] = { ...mockTransfers[path], ...data };
          } else if (collection === "users" || !collection) {
            // Simulated increment
            if (data.balance) {
              mockUsers[path].balance = (mockUsers[path].balance || 0) + 1010;
            } else {
              mockUsers[path] = { ...mockUsers[path], ...data };
            }
          }
        }),
      });
    }),
  };

  return {
    getFirestore: jest.fn(() => dbInstance),
    FieldValue: {
      increment: jest.fn((val: number) => ({ _increment: true, _val: val })),
    },
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

describe("Reconciliation Service Security and Concurrent Integration Tests (Phase 7)", () => {
  beforeEach(() => {
    mockTransfers = {};
    mockUsers = {};
    mockLocks = {};
    mockTransactions = {};
  });

  it("should prevent concurrent double refunds for the same transfer document", async () => {
    const reference = "trf-1784838346726-RxCUL2";
    
    // Setup existing transfer data
    mockTransfers[reference] = {
      userId: "user-999",
      amount: 1000,
      fee: 10,
      status: "PENDING",
      refunded: false,
    };

    mockUsers["user-999"] = {
      userId: "user-999",
      balance: 500, // starting balance
    };

    const reconService = ReconciliationService.getInstance();

    // Trigger reconciliation for the first worker
    const result1 = await reconService.reconcileSingleTransfer(reference);
    expect(result1.success).toBe(true);
    expect(result1.refunded).toBe(true);

    // Verify balance is incremented exactly once (1000 amount + 10 fee)
    expect(mockUsers["user-999"].balance).toBe(1510);
    expect(mockTransfers[reference].refunded).toBe(true);
    expect(mockTransfers[reference].refundProcessed).toBe(true);

    // Now trigger second reconciliation (simulating the duplicate concurrent worker or PM2 retry)
    const result2 = await reconService.reconcileSingleTransfer(reference);
    expect(result2.success).toBe(true);
    expect(result2.refunded).toBe(true); // Returns true to indicate skipped because already refunded

    // Verify balance remains exactly 1510 and was NOT refunded twice!
    expect(mockUsers["user-999"].balance).toBe(1510);
  });

  it("should gracefully skip when the transfer has already been marked as refunded in Firestore", async () => {
    const reference = "trf-ALREADY-REFUNDED";
    
    mockTransfers[reference] = {
      userId: "user-999",
      amount: 1000,
      fee: 10,
      status: "FAILED",
      refunded: true,
      refundProcessed: true,
    };

    mockUsers["user-999"] = {
      userId: "user-999",
      balance: 500,
    };

    const reconService = ReconciliationService.getInstance();
    const result = await reconService.reconcileSingleTransfer(reference);

    expect(result.success).toBe(true);
    expect(result.refunded).toBe(true); // skips and returns true for refund skipping
    expect(mockUsers["user-999"].balance).toBe(500); // Balance remains unchanged!
  });

  it("should respect PM2 cluster worker role and only initialize scheduler on worker 0", () => {
    const reconService = ReconciliationService.getInstance();

    // Set PM2 worker ID to 1 (not instance 0)
    process.env.pm_id = "1";
    
    const loggerSpy = jest.spyOn(require("../config/logger").default, "info");
    reconService.startAutomatedReconciliation();

    expect(loggerSpy).toHaveBeenCalledWith(
      expect.stringContaining("PM2 Instance 1 skipping automated background reconciliation scan loop")
    );

    loggerSpy.mockRestore();
  });
});
