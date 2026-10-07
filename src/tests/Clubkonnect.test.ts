import request from "supertest";
import app from "../app";
import axios from "axios";
import { ClubkonnectService } from "../services/clubkonnect.service";
import { clubkonnectConfig } from "../config/clubkonnect";
import { env } from "../config/env";
import { adminDb } from "../config/firebase";
import jwt from "jsonwebtoken";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

// Mock adminDb
jest.mock("../config/firebase", () => {
  const mDoc = {
    get: jest.fn().mockResolvedValue({ exists: true, data: () => ({ balance: 1000 }) }),
    set: jest.fn(),
    update: jest.fn(),
  };
  const mCollection = {
    doc: jest.fn(() => mDoc),
    where: jest.fn(() => ({
      limit: jest.fn(() => ({
        get: jest.fn()
      }))
    }))
  };
  const mDb = {
    collection: jest.fn(() => mCollection),
    runTransaction: jest.fn((callback) => callback({
      get: jest.fn(),
      set: jest.fn(),
      update: jest.fn(),
    })),
  };
  return {
    firebase: { app: {}, db: mDb, hasCredentials: true },
    adminDb: mDb,
    hasAdminCredentialsActive: true,
  };
});

// Mock firebase-admin/auth to return verified user mock
jest.mock("firebase-admin/auth", () => {
  return {
    getAuth: jest.fn(() => ({
      verifyIdToken: jest.fn().mockResolvedValue({ uid: "test-user-id" }),
    })),
  };
});

const getTestApiKey = () => env.GATEWAY_API_KEYS[0];
const getTestAuthToken = () => {
  return jwt.sign({ uid: "test-user-id" }, env.JWT_SECRET);
};

describe("Clubkonnect Provider Integration Tests", () => {
  const originalUserId = clubkonnectConfig.USER_ID;
  const originalApiKey = clubkonnectConfig.API_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    clubkonnectConfig.USER_ID = "mock-user-123";
    clubkonnectConfig.API_KEY = "mock-api-key-456";

    // Set cache lastFetched to now to prevent triggering dynamic API refreshes during tests
    const { networkCache, dataPlanCache } = require("../config/clubkonnect");
    networkCache.lastFetched = Date.now();
    dataPlanCache.lastFetched = Date.now();
  });

  afterAll(() => {
    clubkonnectConfig.USER_ID = originalUserId;
    clubkonnectConfig.API_KEY = originalApiKey;
  });

  describe("ClubkonnectService.getWalletBalance", () => {
    it("should successfully fetch and parse the balance", async () => {
      mockedAxios.get.mockResolvedValueOnce({
        status: 200,
        data: {
          date: "2023-10-25 12:00:00",
          id: "12345",
          phoneno: "08011112222",
          balance: "4500.50",
        },
      });

      const result = await ClubkonnectService.getWalletBalance("test-req-id");

      expect(result).toEqual({
        success: true,
        provider: "Clubkonnect",
        balance: 4500.5,
      });

      expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    });

    it("should retry up to 2 times (3 total attempts) on request failure", async () => {
      mockedAxios.get
        .mockRejectedValueOnce(new Error("Network Timeout"))
        .mockRejectedValueOnce(new Error("Internal Server Error"))
        .mockResolvedValueOnce({
          status: 200,
          data: {
            date: "2023-10-25 12:00:00",
            id: "12345",
            phoneno: "08011112222",
            balance: "1250",
          },
        });

      const result = await ClubkonnectService.getWalletBalance("test-req-id-retry");

      expect(result).toEqual({
        success: true,
        provider: "Clubkonnect",
        balance: 1250,
      });

      expect(mockedAxios.get).toHaveBeenCalledTimes(3);
    });
  });

  describe("ClubkonnectService.purchaseAirtime", () => {
    it("should successfully purchase airtime", async () => {
      mockedAxios.get.mockResolvedValueOnce({
        status: 200,
        data: {
          status: "ORDER_RECEIVED",
          orderid: "778899",
          remark: "Successful",
        },
      });

      const result = await ClubkonnectService.purchaseAirtime({
        network: "MTN",
        phone: "08031234567",
        amount: 200,
        requestId: "test-airtime-id",
      });

      expect(result).toEqual({
        success: true,
        orderId: "778899",
        status: "Pending",
        message: "Successful",
      });
    });

    it("should fail when Clubkonnect rejects request", async () => {
      mockedAxios.get.mockResolvedValueOnce({
        status: 200,
        data: {
          status: "MALFUNCTIONING",
          remark: "Invalid phone number",
        },
      });

      const result = await ClubkonnectService.purchaseAirtime({
        network: "GLO",
        phone: "08051234567",
        amount: 100,
        requestId: "test-airtime-id-fail",
      });

      expect(result.success).toBe(false);
      expect(result.status).toBe("Failed");
      expect(result.message).toBe("Invalid phone number");
    });
  });

  describe("ClubkonnectService.refreshDataPlanCache (Official Production Nested Schema)", () => {
    it("should successfully parse the exact production nested MOBILE_NETWORK structure from VM logs", async () => {
      mockedAxios.get.mockResolvedValueOnce({
        status: 200,
        data: {
          "MOBILE_NETWORK": {
            "MTN": [
              {
                "ID": "01",
                "PRODUCT": [
                  {
                    "PRODUCT_SNO": "1",
                    "PRODUCT_CODE": "2",
                    "PRODUCT_ID": "500",
                    "PRODUCT_NAME": "500 MB - Weekly (SME)",
                    "PRODUCT_AMOUNT": "307"
                  }
                ]
              }
            ],
            "Glo": [
              {
                "ID": "02",
                "PRODUCT": [
                  {
                    "PRODUCT_SNO": "1",
                    "PRODUCT_CODE": "1",
                    "PRODUCT_ID": "200",
                    "PRODUCT_NAME": "200 MB - 14 days (SME)",
                    "PRODUCT_AMOUNT": "94"
                  }
                ]
              }
            ],
            "m_9mobile": [
              {
                "ID": "03",
                "PRODUCT": [
                  {
                    "PRODUCT_SNO": "1",
                    "PRODUCT_CODE": "1",
                    "PRODUCT_ID": "50",
                    "PRODUCT_NAME": "50 MB - 30 days (SME)",
                    "PRODUCT_AMOUNT": "25"
                  }
                ]
              }
            ],
            "Airtel": [
              {
                "ID": "04",
                "PRODUCT": [
                  {
                    "PRODUCT_SNO": "11",
                    "PRODUCT_CODE": "14",
                    "PRODUCT_ID": "499.91",
                    "PRODUCT_NAME": "1GB - 1 day (Awoof Data)",
                    "PRODUCT_AMOUNT": "484.91"
                  }
                ]
              }
            ]
          }
        }
      });

      // Clear memory cache so it runs refresh
      const { dataPlanCache } = require("../config/clubkonnect");
      dataPlanCache.lastFetched = 0;
      dataPlanCache.plans = {};

      const plans = await ClubkonnectService.getDataPlans("MTN", "test-req-id-prod");
      
      expect(plans.length).toBe(1);
      expect(plans[0]).toEqual({
        item_code: "mtn_500",
        name: "500 MB - Weekly (SME)",
        amount: 307,
        plan_code: "2"
      });

      const gloPlans = await ClubkonnectService.getDataPlans("GLO", "test-req-id-prod-glo");
      expect(gloPlans.length).toBe(1);
      expect(gloPlans[0]).toEqual({
        item_code: "glo_200",
        name: "200 MB - 14 days (SME)",
        amount: 94,
        plan_code: "1"
      });

      const mobile9Plans = await ClubkonnectService.getDataPlans("9MOBILE", "test-req-id-prod-9mob");
      expect(mobile9Plans.length).toBe(1);
      expect(mobile9Plans[0]).toEqual({
        item_code: "9mobile_50",
        name: "50 MB - 30 days (SME)",
        amount: 25,
        plan_code: "1"
      });

      const airtelPlans = await ClubkonnectService.getDataPlans("AIRTEL", "test-req-id-prod-airtel");
      expect(airtelPlans.length).toBe(1);
      expect(airtelPlans[0]).toEqual({
        item_code: "airtel_499.91",
        name: "1GB - 1 day (Awoof Data)",
        amount: 484.91,
        plan_code: "14"
      });
    });
  });

  describe("ClubkonnectService.purchaseData", () => {
    it("should successfully purchase mobile data plan", async () => {
      mockedAxios.get.mockResolvedValueOnce({
        status: 200,
        data: {
          status: "ORDER_RECEIVED",
          orderid: "112233",
          remark: "Accepted",
        },
      });

      const result = await ClubkonnectService.purchaseData({
        network: "MTN",
        phone: "08031234567",
        planCode: "1",
        requestId: "test-data-id",
      });

      expect(result).toEqual({
        success: true,
        orderId: "112233",
        status: "Pending",
        message: "Accepted",
      });
    });
  });

  describe("ClubkonnectService.queryAirtimeTransaction", () => {
    it("should successfully query transaction status", async () => {
      mockedAxios.get.mockResolvedValueOnce({
        status: 200,
        data: {
          status: "Delivered",
          orderid: "778899",
          remark: "Successful delivery",
        },
      });

      const result = await ClubkonnectService.queryAirtimeTransaction({
        orderId: "778899",
      });

      expect(result).toEqual({
        success: true,
        status: "Delivered",
        orderId: "778899",
        remark: "Successful delivery",
      });
    });
  });

  describe("GET /api/vtu/networks", () => {
    it("should return HTTP 200 and available networks list for a valid network response", async () => {
      mockedAxios.get.mockResolvedValueOnce({
        status: 200,
        data: {
          MOBILE_NETWORK: [
            { NETWORK_NAME: "MTN", NETWORK_ID: "01" },
            { NETWORK_NAME: "GLO", NETWORK_ID: "02" },
            { NETWORK_NAME: "AIRTEL", NETWORK_ID: "04" },
            { NETWORK_NAME: "9MOBILE", NETWORK_ID: "03" }
          ]
        }
      });

      const res = await request(app).get("/api/vtu/networks");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.networks).toEqual(expect.arrayContaining(["MTN", "GLO", "AIRTEL", "9MOBILE"]));
    });

    it("should fail fast and fallback to cached networks when provider response is invalid or undefined", async () => {
      // Mock to return undefined/error response
      mockedAxios.get.mockResolvedValueOnce(undefined as any);

      const res = await request(app).get("/api/vtu/networks");
      expect(res.status).toBe(200); // returns 200 using local fallback mapping
      expect(res.body.success).toBe(true);
      expect(res.body.networks).toEqual(expect.arrayContaining(["MTN", "GLO", "AIRTEL", "9MOBILE"]));
    });
  });

  describe("GET /api/vtu/data/plans", () => {
    it("should return HTTP 200 and available MTN data plans list", async () => {
      const res = await request(app).get("/api/vtu/data/plans?network=MTN");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.data[0].item_code).toBe("mtn_500");
    });
  });

  describe("POST /api/vtu/airtime", () => {
    it("should validate and execute airtime purchase with 200 OK under Option 1", async () => {
      // Mock user document balance retrieve
      const mockUserDoc = {
        exists: true,
        data: () => ({ balance: 1000 }),
      };

      // Mock runTransaction return values
      (adminDb!.runTransaction as jest.Mock).mockImplementationOnce(async (callback) => {
        return callback({
          get: jest.fn().mockResolvedValue(mockUserDoc),
          set: jest.fn(),
          update: jest.fn(),
        });
      });

      // Mock API call to Clubkonnect V1
      mockedAxios.get.mockResolvedValueOnce({
        status: 200,
        data: {
          status: "ORDER_RECEIVED",
          orderid: "998811",
          remark: "Accepted",
        },
      });

      const res = await request(app)
        .post("/api/vtu/airtime")
        .set("X-API-Key", getTestApiKey())
        .set("X-Session-ID", "test-session-123")
        .set("Authorization", `Bearer ${getTestAuthToken()}`)
        .send({
          network: "MTN",
          phone: "08031234567",
          amount: 100,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.orderId).toBe("998811");
    });

    it("should reject invalid amount under ₦50", async () => {
      const res = await request(app)
        .post("/api/vtu/airtime")
        .set("X-API-Key", getTestApiKey())
        .set("X-Session-ID", "test-session-123")
        .set("Authorization", `Bearer ${getTestAuthToken()}`)
        .send({
          network: "MTN",
          phone: "08031234567",
          amount: 20,
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("amount must be between ₦50 and ₦200,000");
    });

    it("should map AIRTIME_RECIPIENT_PURCHASE_LIMIT_REACHED to clear user-facing limit error message", async () => {
      const mockUserDoc = {
        exists: true,
        data: () => ({ balance: 1000 }),
      };

      (adminDb!.runTransaction as jest.Mock).mockImplementationOnce(async (callback) => {
        return callback({
          get: jest.fn().mockResolvedValue(mockUserDoc),
          set: jest.fn(),
          update: jest.fn(),
        });
      });

      mockedAxios.get.mockResolvedValueOnce({
        status: 200,
        data: {
          status: "FAILED",
          remark: "AIRTIME_RECIPIENT_PURCHASE_LIMIT_REACHED",
        },
      });

      const res = await request(app)
        .post("/api/vtu/airtime")
        .set("X-API-Key", getTestApiKey())
        .set("X-Session-ID", "test-session-123")
        .set("Authorization", `Bearer ${getTestAuthToken()}`)
        .send({
          network: "MTN",
          phone: "08031234567",
          amount: 100,
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toBe("This recipient has reached the airtime purchase limit. Please try another phone number.");
    });
  });

  describe("POST /api/vtu/data", () => {
    it("should validate and execute data purchase with 200 OK under Option 1", async () => {
      const mockUserDoc = {
        exists: true,
        data: () => ({ balance: 1000 }),
      };

      (adminDb!.runTransaction as jest.Mock).mockImplementationOnce(async (callback) => {
        return callback({
          get: jest.fn().mockResolvedValue(mockUserDoc),
          set: jest.fn(),
          update: jest.fn(),
        });
      });

      mockedAxios.get.mockResolvedValueOnce({
        status: 200,
        data: {
          status: "ORDER_RECEIVED",
          orderid: "445566",
          remark: "Accepted",
        },
      });

      const res = await request(app)
        .post("/api/vtu/data")
        .set("X-API-Key", getTestApiKey())
        .set("X-Session-ID", "test-session-123")
        .set("Authorization", `Bearer ${getTestAuthToken()}`)
        .send({
          network: "MTN",
          phone: "08031234567",
          item_code: "mtn_500",
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.orderId).toBe("445566");
    });

    it("should reject if data plan package code is invalid", async () => {
      const res = await request(app)
        .post("/api/vtu/data")
        .set("X-API-Key", getTestApiKey())
        .set("X-Session-ID", "test-session-123")
        .set("Authorization", `Bearer ${getTestAuthToken()}`)
        .send({
          network: "MTN",
          phone: "08031234567",
          item_code: "invalid_plan_id",
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("selected data plan package is inactive");
    });
  });

  describe("POST /api/vtu/clubkonnect/callback", () => {
    it("should successfully update Delivered callback status", async () => {
      const mockVtuTxDoc = {
        exists: true,
        ref: { update: jest.fn() },
        data: () => ({
          status: "Pending",
          transactionRef: "VTU-AIR-12345",
          userId: "test-user-id",
          amount: 100,
          phone: "08031234567",
        }),
      };

      const mockQuerySnap = {
        empty: false,
        docs: [mockVtuTxDoc],
      };

      (adminDb!.collection as jest.Mock).mockReturnValue({
        doc: jest.fn(() => ({ get: jest.fn() })),
        where: jest.fn(() => ({
          limit: jest.fn(() => ({
            get: jest.fn().mockResolvedValue(mockQuerySnap),
          })),
        })),
      });

      (adminDb!.runTransaction as jest.Mock).mockImplementationOnce(async (callback) => {
        return callback({
          get: jest.fn().mockResolvedValue(mockVtuTxDoc),
          set: jest.fn(),
          update: jest.fn(),
        });
      });

      const res = await request(app)
        .post("/api/vtu/clubkonnect/callback")
        .send({
          status: "delivered",
          orderid: "778899",
          requestid: "12345",
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });
});
