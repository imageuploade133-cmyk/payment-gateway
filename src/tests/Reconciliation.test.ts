import { ReconciliationService } from "../services/reconciliationService";
import { ClubkonnectService } from "../services/clubkonnect.service";

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

// Mock Clubkonnect Service
jest.mock("../services/clubkonnect.service", () => {
  return {
    ClubkonnectService: {
      queryAirtimeTransaction: jest.fn(),
    },
  };
});

// Setup mock Firestore state
let mockTransfers: Record<string, any> = {};
let mockUsers: Record<string, any> = {};
let mockLocks: Record<string, any> = {};
let mockTransactions: Record<string, any> = {};
let mockVtuTransactions: Record<string, any> = {};
let mockVtuLocks: Record<string, any> = {};

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
        } else if (collectionName === "vtu_transactions" && mockVtuTransactions[id]) {
          exists = true;
          data = mockVtuTransactions[id];
        } else if (collectionName === "vtu_reconciliation_locks" && mockVtuLocks[id]) {
          exists = true;
          data = mockVtuLocks[id];
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
        } else if (collectionName === "vtu_reconciliation_locks") {
          mockVtuLocks[id] = data;
        } else if (collectionName === "transfers") {
          mockTransfers[id] = { ...mockTransfers[id], ...data };
        } else if (collectionName === "vtu_transactions") {
          mockVtuTransactions[id] = { ...mockVtuTransactions[id], ...data };
        } else if (collectionName === "users") {
          mockUsers[id] = { ...mockUsers[id], ...data };
        } else if (collectionName === "transactions") {
          mockTransactions[id] = data;
        }
      }),
      update: jest.fn(async (data: any) => {
        if (collectionName === "transfers") {
          mockTransfers[id] = { ...mockTransfers[id], ...data };
        } else if (collectionName === "vtu_transactions") {
          mockVtuTransactions[id] = { ...mockVtuTransactions[id], ...data };
        } else if (collectionName === "users") {
          mockUsers[id] = { ...mockUsers[id], ...data };
        }
      }),
      delete: jest.fn(async () => {
        if (collectionName === "reconciliation_locks") {
          delete mockLocks[id];
        } else if (collectionName === "vtu_reconciliation_locks") {
          delete mockVtuLocks[id];
        }
      }),
    };
  };

  const getMockCollection = (collectionName: string) => {
    return {
      doc: jest.fn((id: string) => getMockDoc(collectionName, id)),
      where: jest.fn(() => ({
        get: jest.fn(async () => {
          const list = Object.entries(mockVtuTransactions)
            .filter(([_, v]) => v.status === "Pending")
            .map(([k, v]) => getMockDoc("vtu_transactions", k));
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
          } else if (collection === "reconciliation_locks" && mockLocks[path]) {
            exists = true;
            data = mockLocks[path];
          } else if (collection === "vtu_reconciliation_locks" && mockVtuLocks[path]) {
            exists = true;
            data = mockVtuLocks[path];
          } else if (collection === "vtu_transactions" && mockVtuTransactions[path]) {
            exists = true;
            data = mockVtuTransactions[path];
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
          } else if (collection === "vtu_reconciliation_locks") {
            mockVtuLocks[path] = data;
          } else if (collection === "transfers") {
            mockTransfers[path] = { ...mockTransfers[path], ...data };
          } else if (collection === "vtu_transactions") {
            mockVtuTransactions[path] = { ...mockVtuTransactions[path], ...data };
          } else if (collection === "transactions") {
            mockTransactions[path] = data;
          }
        }),
        update: jest.fn((docRef: any, data: any) => {
          const path = docRef.id;
          const collection = docRef._collection || "transfers";
          if (collection === "transfers") {
            mockTransfers[path] = { ...mockTransfers[path], ...data };
          } else if (collection === "vtu_transactions") {
            mockVtuTransactions[path] = { ...mockVtuTransactions[path], ...data };
          } else if (collection === "users") {
            if (data && "balance" in data) {
              if (typeof data.balance === "object" && data.balance !== null && "operand" in data.balance) {
                // Handle FieldValue.increment
                mockUsers[path].balance = (mockUsers[path].balance || 0) + data.balance.operand;
              } else {
                mockUsers[path].balance = data.balance;
              }
            } else {
              mockUsers[path] = { ...mockUsers[path], ...data };
            }
          } else if (collection === "transactions") {
            mockTransactions[path] = { ...mockTransactions[path], ...data };
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

  describe("VTU Automated Reconciliation Tests", () => {
    const transactionRef = "VTU-AIR-test-vtu-id";

    beforeEach(() => {
      mockVtuTransactions = {};
      mockVtuLocks = {};
      mockUsers = {};
      mockTransactions = {};
      jest.clearAllMocks();
    });

    it("should successfully transition a pending VTU transaction to Delivered when provider query succeeds", async () => {
      mockVtuTransactions[transactionRef] = {
        userId: "test-user-id",
        amount: 200,
        status: "Pending",
        phone: "08031234567",
        requestId: "test-vtu-id",
        providerOrderId: "112233",
        type: "Airtime",
      };

      mockUsers["test-user-id"] = {
        userId: "test-user-id",
        balance: 1000,
      };

      // Mock query response to return "Delivered"
      (ClubkonnectService.queryAirtimeTransaction as jest.Mock).mockResolvedValueOnce({
        success: true,
        status: "Delivered",
        orderId: "112233",
        remark: "Successful delivery",
      });

      const reconService = ReconciliationService.getInstance();
      const result = await reconService.reconcileSingleVtuTransaction(transactionRef);

      expect(result.success).toBe(true);
      expect(result.status).toBe("Delivered");

      // Verify DB updates
      expect(mockVtuTransactions[transactionRef].status).toBe("Delivered");
      // The general ledger transactions record is updated to SUCCESS
      expect(mockTransactions[`tx-${transactionRef}`].status).toBe("SUCCESS");
      // No refund should be processed, so balance is unchanged
      expect(mockUsers["test-user-id"].balance).toBe(1000);
    });

    it("should successfully transition a pending VTU transaction to Failed and trigger a secure refund on provider failure", async () => {
      mockVtuTransactions[transactionRef] = {
        userId: "test-user-id",
        amount: 200,
        status: "Pending",
        phone: "08031234567",
        requestId: "test-vtu-id",
        providerOrderId: "112233",
        type: "Airtime",
        refundProcessed: false,
      };

      mockUsers["test-user-id"] = {
        userId: "test-user-id",
        balance: 1000,
      };

      // Mock query response to return "Failed"
      (ClubkonnectService.queryAirtimeTransaction as jest.Mock).mockResolvedValueOnce({
        success: true,
        status: "Failed",
        orderId: "112233",
        remark: "Invalid number",
      });

      const reconService = ReconciliationService.getInstance();
      const result = await reconService.reconcileSingleVtuTransaction(transactionRef);

      expect(result.success).toBe(true);
      expect(result.status).toBe("Failed");

      // Verify DB updates
      expect(mockVtuTransactions[transactionRef].status).toBe("Failed");
      expect(mockVtuTransactions[transactionRef].refundProcessed).toBe(true);

      // Verify general ledger transactions record status is updated to FAILED
      expect(mockTransactions[`tx-${transactionRef}`].status).toBe("FAILED");

      // Verify refund ledger transaction is created
      expect(mockTransactions[`tx-REFUND-${transactionRef}`]).toBeDefined();
      expect(mockTransactions[`tx-REFUND-${transactionRef}`].amount).toBe(200);
      expect(mockTransactions[`tx-REFUND-${transactionRef}`].status).toBe("SUCCESS");

      // Verify user balance is atomically refunded (+200)
      expect(mockUsers["test-user-id"].balance).toBe(1200);
    });

    it("should keep status Pending if the provider returns an ambiguous response", async () => {
      mockVtuTransactions[transactionRef] = {
        userId: "test-user-id",
        amount: 200,
        status: "Pending",
        phone: "08031234567",
        requestId: "test-vtu-id",
        providerOrderId: "112233",
        type: "Airtime",
      };

      mockUsers["test-user-id"] = {
        userId: "test-user-id",
        balance: 1000,
      };

      // Mock query response to return "Processing" or unknown
      (ClubkonnectService.queryAirtimeTransaction as jest.Mock).mockResolvedValueOnce({
        success: true,
        status: "Processing",
        orderId: "112233",
        remark: "In progress",
      });

      const reconService = ReconciliationService.getInstance();
      const result = await reconService.reconcileSingleVtuTransaction(transactionRef);

      expect(result.success).toBe(true);
      expect(result.status).toBe("Pending");

      // Verify DB is untouched
      expect(mockVtuTransactions[transactionRef].status).toBe("Pending");
      expect(mockUsers["test-user-id"].balance).toBe(1000);
    });

    it("should skip already terminal transactions idempotently", async () => {
      mockVtuTransactions[transactionRef] = {
        userId: "test-user-id",
        amount: 200,
        status: "Delivered",
        phone: "08031234567",
        requestId: "test-vtu-id",
        providerOrderId: "112233",
        type: "Airtime",
      };

      const reconService = ReconciliationService.getInstance();
      const result = await reconService.reconcileSingleVtuTransaction(transactionRef);

      expect(result.success).toBe(true);
      expect(result.status).toBe("DELIVERED"); // returns the existing uppercase status and exits early

      // No API calls should be made
      expect(ClubkonnectService.queryAirtimeTransaction).not.toHaveBeenCalled();
    });
  });
});
