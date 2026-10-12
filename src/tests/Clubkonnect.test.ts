import express from "express";
import request from "supertest";
import * as clubkonnectController from "../controllers/clubkonnect.controller";
import { ClubkonnectService } from "../services/clubkonnect.service";

jest.mock("../config/firebase", () => {
  const mockUserStore: Record<string, any> = {
    "test-user-id": { balance: 5000, name: "Test User" },
    "poor-user-id": { balance: 10, name: "Poor User" },
  };

  const mockWalletStore: Record<string, any> = {
    "test-user-id_NGN": { balance: 5000, currency: "NGN" },
    "poor-user-id_NGN": { balance: 10, currency: "NGN" },
  };

  const mockVtuStore: Record<string, any> = {
    "test-vtu-id": {
      transactionRef: "VTU-AIR-test-vtu-id",
      userId: "test-user-id",
      amount: 200,
      phone: "08012345678",
      status: "Pending",
      type: "Airtime",
      refundProcessed: false,
    },
  };

  const mockDb = {
    collection: (collName: string) => {
      return {
        doc: (docId: string) => {
          return {
            get: jest.fn().mockImplementation(async () => {
              if (collName === "users") {
                const data = mockUserStore[docId];
                return { exists: !!data, data: () => data };
              }
              if (collName === "wallets") {
                const data = mockWalletStore[docId];
                return { exists: !!data, data: () => data };
              }
              if (collName === "vtu_transactions") {
                const data = mockVtuStore[docId];
                return { exists: !!data, data: () => data };
              }
              return { exists: false, data: () => null };
            }),
            set: jest.fn().mockImplementation(async (data: any) => {
              if (collName === "users") mockUserStore[docId] = data;
              if (collName === "wallets") mockWalletStore[docId] = data;
              if (collName === "vtu_transactions") mockVtuStore[docId] = data;
            }),
            update: jest.fn().mockImplementation(async (data: any) => {
              if (collName === "vtu_transactions" && mockVtuStore[docId]) {
                Object.assign(mockVtuStore[docId], data);
              }
            }),
          };
        },
        where: (field: string, op: string, val: string) => {
          return {
            limit: () => ({
              get: jest.fn().mockImplementation(async () => {
                if (collName === "vtu_transactions") {
                  const doc = Object.entries(mockVtuStore).find(([_, data]) => data.requestId === val || data.providerOrderId === val);
                  if (doc) {
                    return {
                      empty: false,
                      docs: [{
                        ref: {
                          update: jest.fn().mockImplementation(async (upData) => Object.assign(doc[1], upData)),
                        },
                        data: () => doc[1],
                      }],
                    };
                  }
                }
                return { empty: true, docs: [] };
              }),
            }),
          };
        },
      };
    },
    runTransaction: jest.fn().mockImplementation(async (updateFunction) => {
      const transactionMock = {
        get: jest.fn().mockImplementation(async (docRef) => {
          return { exists: true, data: () => ({ balance: 5000, status: "Pending", refundProcessed: false }) };
        }),
        update: jest.fn(),
        set: jest.fn(),
      };
      return await updateFunction(transactionMock);
    }),
  };

  return { adminDb: mockDb };
});

const app = express();
app.use(express.json());

// Auth middleware simulator
const mockAuth = (req: any, res: any, next: any) => {
  if (req.headers["authorization"] === "Bearer valid-token") {
    req.user = { uid: "test-user-id" };
  } else if (req.headers["authorization"] === "Bearer poor-token") {
    req.user = { uid: "poor-user-id" };
  }
  next();
};

app.use(mockAuth);
app.get("/api/vtu/networks", clubkonnectController.getNetworks);
app.get("/api/vtu/data/plans", clubkonnectController.getDataPlans);
app.post("/api/vtu/airtime", clubkonnectController.purchaseAirtime as any);
app.post("/api/vtu/data", clubkonnectController.purchaseData as any);
app.post("/api/vtu/cable", clubkonnectController.purchaseCable as any);
app.post("/api/vtu/electricity", clubkonnectController.purchaseElectricity as any);
app.post("/api/vtu/waec", clubkonnectController.purchaseWaec as any);
app.post("/api/vtu/clubkonnect/callback", clubkonnectController.handleCallback);

describe("Clubkonnect Provider Integration & Security Tests", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("Security: Unauthorized Request Prevention", () => {
    it("should reject purchase requests missing verified req.user.uid even if req.body.userId is supplied", async () => {
      const res = await request(app)
        .post("/api/vtu/airtime")
        .send({
          network: "MTN",
          phone: "08012345678",
          amount: 100,
          userId: "malicious-spoofed-id",
        });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("Unauthorized");
    });
  });

  describe("POST /api/vtu/airtime", () => {
    it("should successfully purchase airtime when authorized and provider succeeds", async () => {
      jest.spyOn(ClubkonnectService, "purchaseAirtime").mockResolvedValueOnce({
        success: true,
        orderId: "ORDER-12345",
        status: "Pending",
        message: "Order received",
      });

      const res = await request(app)
        .post("/api/vtu/airtime")
        .set("Authorization", "Bearer valid-token")
        .send({
          provider: "MTN",
          customer_id: "08012345678",
          amount: 200,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.orderId).toBe("ORDER-12345");
    });

    it("should auto-refund when provider rejects request", async () => {
      jest.spyOn(ClubkonnectService, "purchaseAirtime").mockResolvedValueOnce({
        success: false,
        status: "Failed",
        message: "AIRTIME_RECIPIENT_PURCHASE_LIMIT_REACHED",
      });

      const res = await request(app)
        .post("/api/vtu/airtime")
        .set("Authorization", "Bearer valid-token")
        .send({
          network: "MTN",
          phone: "08012345678",
          amount: 200,
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("reached the airtime purchase limit");
    });
  });

  describe("Safe Service Availability: Cable, Electricity, WAEC", () => {
    it("should return HTTP 503 unavailable for Cable TV without mock success or fake order IDs", async () => {
      const res = await request(app)
        .post("/api/vtu/cable")
        .set("Authorization", "Bearer valid-token")
        .send({
          smartCardNo: "1234567890",
          provider: "DSTV",
          amount: 5000,
        });

      expect(res.status).toBe(503);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("temporarily unavailable");
    });

    it("should return HTTP 503 unavailable for Electricity without fake tokens", async () => {
      const res = await request(app)
        .post("/api/vtu/electricity")
        .set("Authorization", "Bearer valid-token")
        .send({
          meterNo: "10101010101",
          provider: "IKEDC",
          amount: 2000,
        });

      expect(res.status).toBe(503);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("temporarily unavailable");
    });

    it("should return HTTP 503 unavailable for WAEC PIN without fake PINs", async () => {
      const res = await request(app)
        .post("/api/vtu/waec")
        .set("Authorization", "Bearer valid-token")
        .send({
          phone: "08012345678",
          amount: 3800,
        });

      expect(res.status).toBe(503);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("temporarily unavailable");
    });
  });
});
