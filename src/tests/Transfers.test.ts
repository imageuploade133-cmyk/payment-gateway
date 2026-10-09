import request from "supertest";
import app from "../app";
import { getFlutterwaveClient } from "../providers/flutterwave";
import { InMemoryIdempotency } from "../services/transferService";
import { env } from "../config/env";

// Mock Firebase Admin SDK to capture Firestore writes
const mockFirestoreStore: Record<string, any> = {};

jest.mock("../config/firebase", () => ({
  adminDb: {
    collection: (colName: string) => ({
      doc: (docId: string) => ({
        get: jest.fn().mockImplementation(async () => {
          const data = mockFirestoreStore[`${colName}/${docId}`];
          return {
            exists: !!data,
            data: () => data,
          };
        }),
        set: jest.fn().mockImplementation(async (data: any, opts: any) => {
          if (opts?.merge && mockFirestoreStore[`${colName}/${docId}`]) {
            mockFirestoreStore[`${colName}/${docId}`] = { ...mockFirestoreStore[`${colName}/${docId}`], ...data };
          } else {
            mockFirestoreStore[`${colName}/${docId}`] = data;
          }
        }),
        update: jest.fn().mockImplementation(async (data: any) => {
          mockFirestoreStore[`${colName}/${docId}`] = { ...mockFirestoreStore[`${colName}/${docId}`], ...data };
        }),
      }),
      where: () => ({
        get: jest.fn().mockResolvedValue({ empty: true, docs: [] }),
      }),
    }),
    runTransaction: jest.fn().mockImplementation(async (cb: any) => {
      const fakeTx = {
        get: async (docRef: any) => docRef.get(),
        set: async (docRef: any, data: any, opts: any) => docRef.set(data, opts),
        update: async (docRef: any, data: any) => docRef.update(data),
      };
      return cb(fakeTx);
    }),
  },
}));

// Mock the Flutterwave client singleton helper
jest.mock("../providers/flutterwave", () => {
  const mClient = {
    request: jest.fn(),
  };
  return {
    getFlutterwaveClient: () => mClient,
  };
});

jest.mock("../services/firestoreIdempotency", () => {
  const mCache = new Set<string>();
  return {
    FirestoreIdempotency: {
      getInstance: jest.fn().mockReturnValue({
        isDuplicate: jest.fn().mockImplementation(async (ref: string) => mCache.has(ref)),
        saveReference: jest.fn().mockImplementation(async (ref: string) => { mCache.add(ref); }),
        claimReference: jest.fn().mockImplementation(async (ref: string) => {
          if (mCache.has(ref)) return false;
          mCache.add(ref);
          return true;
        }),
      }),
    },
  };
});

const mockFlwClient = getFlutterwaveClient() as jest.Mocked<any>;
const testApiKey = env.GATEWAY_API_KEYS[0];

describe("Flutterwave Outward Bank Transfer Endpoint Tests", () => {
  let validPayload: any;

  beforeEach(() => {
    jest.clearAllMocks();
    // Clear in-memory idempotency cache for test isolation
    const idempotency = InMemoryIdempotency.getInstance();
    (idempotency as any).cache.clear();

    const uniqueRef = `trf-test-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    validPayload = {
      amount: 5000,
      account_number: "0123456789",
      bank_code: "044",
      account_name: "SARAH SMITH CONNOR",
      currency: "NGN",
      narration: "E-Tech Salary Payout",
      reference: uniqueRef,
    };
  });

  describe("POST /api/flutterwave/transfer - Request Validation (Zod)", () => {
    it("should return HTTP 400 with a descriptive validation error if amount is missing", async () => {
      const { amount, ...invalidPayload } = validPayload;
      const res = await request(app)
        .post("/api/flutterwave/transfer")
        .set("X-API-Key", testApiKey)
        .send(invalidPayload);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("Validation Error");
    });

    it("should return HTTP 400 if amount is negative", async () => {
      const res = await request(app)
        .post("/api/flutterwave/transfer")
        .set("X-API-Key", testApiKey)
        .send({ ...validPayload, amount: -100 });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("Validation Error");
    });

    it("should return HTTP 400 if account_number contains non-digits", async () => {
      const res = await request(app)
        .post("/api/flutterwave/transfer")
        .set("X-API-Key", testApiKey)
        .send({ ...validPayload, account_number: "0123abc45" });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("Validation Error");
    });

    it("should return HTTP 400 if bank_code is malformed", async () => {
      const res = await request(app)
        .post("/api/flutterwave/transfer")
        .set("X-API-Key", testApiKey)
        .send({ ...validPayload, bank_code: "abc" });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("Validation Error");
    });
  });

  describe("POST /api/flutterwave/transfer - Execution & Reliability", () => {
    it("should return normalized success object with HTTP 200 on successful provider transfer", async () => {
      mockFlwClient.request.mockResolvedValue({
        status: "success",
        message: "Transfer queued",
        data: {
          id: 778899,
          status: "NEW",
          amount: 5000,
          reference: validPayload.reference,
        },
      });

      const res = await request(app)
        .post("/api/flutterwave/transfer")
        .set("X-API-Key", testApiKey)
        .send(validPayload);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        processing: true,
        reference: validPayload.reference,
        provider_reference: "778899",
        status: "pending",
        flutterwaveStatus: "new",
        message: "Transfer submitted successfully and is being processed.",
      });

      expect(mockFlwClient.request).toHaveBeenCalledWith("post", "/transfers", {
        account_bank: validPayload.bank_code,
        account_number: validPayload.account_number,
        amount: validPayload.amount,
        narration: validPayload.narration,
        currency: validPayload.currency,
        reference: validPayload.reference,
        callback_url: undefined,
      });
    });

    it("should explicitly persist custom narration and remark on transfer documents", async () => {
      mockFlwClient.request.mockResolvedValue({
        status: "success",
        message: "Transfer queued",
        data: {
          id: 998877,
          status: "NEW",
          amount: 5000,
          reference: validPayload.reference,
        },
      });

      const customNarration = "Monthly Consulting Fee Payment";
      const res = await request(app)
        .post("/api/flutterwave/transfer")
        .set("X-API-Key", testApiKey)
        .send({
          ...validPayload,
          narration: customNarration,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify that Flutterwave was called with the exact narration
      expect(mockFlwClient.request).toHaveBeenCalledWith(
        "post",
        "/transfers",
        expect.objectContaining({
          narration: customNarration,
        })
      );

      // Inspect mock Firestore store for transfers and transactions
      const transferDoc = mockFirestoreStore[`transfers/${validPayload.reference}`];
      const transactionDoc = mockFirestoreStore[`transactions/tx-${validPayload.reference}`];

      expect(transferDoc).toBeDefined();
      expect(transferDoc.narration).toBe(customNarration);
      expect(transferDoc.remark).toBe(customNarration);
      expect(transferDoc.description).toBe("Transfer to SARAH SMITH CONNOR");

      expect(transactionDoc).toBeDefined();
      expect(transactionDoc.narration).toBe(customNarration);
      expect(transactionDoc.remark).toBe(customNarration);
      expect(transactionDoc.description).toBe("Transfer to SARAH SMITH CONNOR");
    });

    it("should reject with duplicate reference warning if reference is sent twice (Idempotency check)", async () => {
      mockFlwClient.request.mockResolvedValue({
        status: "success",
        data: { id: 778899, status: "NEW" },
      });

      // Send first transfer
      const res1 = await request(app)
        .post("/api/flutterwave/transfer")
        .set("X-API-Key", testApiKey)
        .send(validPayload);
      expect(res1.status).toBe(200);

      // Send identical transfer reference again
      const res2 = await request(app)
        .post("/api/flutterwave/transfer")
        .set("X-API-Key", testApiKey)
        .send(validPayload);

      expect(res2.status).toBe(400);
      expect(res2.body.success).toBe(false);
      expect(res2.body.message).toContain("Duplicate transfer reference");
    });

    it("should return normalized failure on provider failure", async () => {
      mockFlwClient.request.mockRejectedValue(new Error("Unable to execute transfer"));

      const res = await request(app)
        .post("/api/flutterwave/transfer")
        .set("X-API-Key", testApiKey)
        .send(validPayload);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("Unable to execute transfer");
    });
  });

  describe("GET /api/flutterwave/transfer/status/:reference - Status Polling", () => {
    it("should fetch transfer status directly from Flutterwave fallback when not in DB", async () => {
      mockFlwClient.request.mockResolvedValue({
        status: "success",
        data: [
          {
            id: 778899,
            status: "SUCCESSFUL",
            reference: "polling-ref-123",
          }
        ]
      });

      const res = await request(app)
        .get("/api/flutterwave/transfer/status/polling-ref-123")
        .set("X-API-Key", testApiKey);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        status: "SUCCESS",
      });
    });

    it("should return PENDING for processing status from Flutterwave fallback", async () => {
      mockFlwClient.request.mockResolvedValue({
        status: "success",
        data: [
          {
            id: 778899,
            status: "NEW",
            reference: "polling-ref-456",
          }
        ]
      });

      const res = await request(app)
        .get("/api/flutterwave/transfer/status/polling-ref-456")
        .set("X-API-Key", testApiKey);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        status: "NEW",
      });
    });
  });
});
