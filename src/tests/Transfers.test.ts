import request from "supertest";
import app from "../app";
import { getFlutterwaveClient } from "../providers/flutterwave";
import { InMemoryIdempotency } from "../services/transferService";
import { env } from "../config/env";
import jwt from "jsonwebtoken";

// Mock Firebase Admin SDK
const mockFirestoreStore: Record<string, any> = {};

const mockVerifyIdToken = jest.fn();

jest.mock("firebase-admin/auth", () => ({
  getAuth: jest.fn(() => ({
    verifyIdToken: mockVerifyIdToken,
  })),
}));

jest.mock("../config/firebase", () => ({
  firebase: { app: { name: "[DEFAULT]" } },
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

describe("Flutterwave Outward Bank Transfer Authentication & Execution Tests", () => {
  let validPayload: any;
  let validJwtToken: string;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFirestoreStore["users/test-user-id"] = { balance: 100000, activeSessionId: "test-session-id-123" };
    mockFirestoreStore["wallets/test-user-id_NGN"] = { balance: 100000 };

    mockVerifyIdToken.mockResolvedValue({
      uid: "test-user-id",
      email: "user@e-tech-hub.com",
    });

    validJwtToken = "header.payload.mock_firebase_id_token";

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

  describe("Authentication & Identity Assertion Security", () => {
    it("1. Valid API key with no user identity should be rejected with HTTP 401 and NEVER call Flutterwave", async () => {
      const res = await request(app)
        .post("/api/flutterwave/transfer")
        .set("X-API-Key", testApiKey)
        .send(validPayload);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("Authentication Error");
      expect(mockFlwClient.request).not.toHaveBeenCalled();
    });

    it("2. Invalid API key should be rejected with HTTP 401 and NEVER call Flutterwave", async () => {
      const res = await request(app)
        .post("/api/flutterwave/transfer")
        .set("X-API-Key", "invalid-key-999")
        .send(validPayload);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("Unauthorized");
      expect(mockFlwClient.request).not.toHaveBeenCalled();
    });

    it("3. Forged UID header alongside API key should be ignored and rejected with HTTP 401", async () => {
      const res = await request(app)
        .post("/api/flutterwave/transfer")
        .set("X-API-Key", testApiKey)
        .set("X-User-UID", "forged-admin-uid")
        .set("X-Authenticated-User-ID", "forged-admin-uid")
        .send(validPayload);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("Authentication Error");
      expect(mockFlwClient.request).not.toHaveBeenCalled();
    });

    it("4. Forged body userId/uid without verified token should be rejected with HTTP 401", async () => {
      const forgedBodyPayload = {
        ...validPayload,
        userId: "forged-user-id",
        uid: "forged-user-id",
      };

      const res = await request(app)
        .post("/api/flutterwave/transfer")
        .set("X-API-Key", testApiKey)
        .send(forgedBodyPayload);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("Authentication Error");
      expect(mockFlwClient.request).not.toHaveBeenCalled();
    });

    it("5. Properly authenticated user via Bearer token should execute transfer successfully", async () => {
      mockFlwClient.request.mockResolvedValueOnce({
        status: "success",
        message: "Transfer queued",
        data: { id: 887766, status: "NEW" },
      });

      const res = await request(app)
        .post("/api/flutterwave/transfer")
        .set("Authorization", `Bearer ${validJwtToken}`)
        .set("X-Session-ID", "test-session-id-123")
        .send(validPayload);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(mockFlwClient.request).toHaveBeenCalledWith(
        "post",
        "/transfers",
        expect.objectContaining({
          reference: validPayload.reference,
          amount: 5000,
        })
      );
    });

    it("6. Legitimate E-Global server-to-server transfer with Bearer token should process successfully", async () => {
      mockFlwClient.request.mockResolvedValueOnce({
        status: "success",
        message: "Transfer initiated",
        data: { id: 112233, status: "SUCCESSFUL" },
      });

      const res = await request(app)
        .post("/api/flutterwave/transfer")
        .set("Authorization", `Bearer ${validJwtToken}`)
        .set("X-Session-ID", "test-session-id-123")
        .send(validPayload);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.provider_reference).toBe("112233");
    });
  });

  describe("Transfer Validation & Execution Logic (Restored)", () => {
    it("7. Should return HTTP 400 validation error if amount is missing", async () => {
      const { amount, ...invalidPayload } = validPayload;
      const res = await request(app)
        .post("/api/flutterwave/transfer")
        .set("Authorization", `Bearer ${validJwtToken}`)
        .set("X-Session-ID", "test-session-id-123")
        .send(invalidPayload);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("Validation Error");
      expect(mockFlwClient.request).not.toHaveBeenCalled();
    });

    it("8. Should explicitly persist custom narration and remark on transfer documents", async () => {
      mockFlwClient.request.mockResolvedValueOnce({
        status: "success",
        message: "Transfer queued",
        data: { id: 776655, status: "NEW" },
      });

      const customNarration = "E-Tech Custom Narration Note";
      const res = await request(app)
        .post("/api/flutterwave/transfer")
        .set("Authorization", `Bearer ${validJwtToken}`)
        .set("X-Session-ID", "test-session-id-123")
        .send({
          ...validPayload,
          narration: customNarration,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const transferDoc = mockFirestoreStore[`transfers/${validPayload.reference}`];
      expect(transferDoc).toBeDefined();
      expect(transferDoc.narration).toBe(customNarration);

      const transactionDoc = mockFirestoreStore[`transactions/tx-${validPayload.reference}`];
      expect(transactionDoc).toBeDefined();
      expect(transactionDoc.narration).toBe(customNarration);
    });

    it("9. Should reject duplicate transfer reference if sent twice (Idempotency check)", async () => {
      mockFlwClient.request.mockResolvedValue({
        status: "success",
        message: "Transfer queued",
        data: { id: 887766, status: "NEW" },
      });

      const res1 = await request(app)
        .post("/api/flutterwave/transfer")
        .set("Authorization", `Bearer ${validJwtToken}`)
        .set("X-Session-ID", "test-session-id-123")
        .send(validPayload);
      expect(res1.status).toBe(200);

      // Send identical transfer reference again
      const res2 = await request(app)
        .post("/api/flutterwave/transfer")
        .set("Authorization", `Bearer ${validJwtToken}`)
        .set("X-Session-ID", "test-session-id-123")
        .send(validPayload);

      expect(res2.status).toBe(400);
      expect(res2.body.success).toBe(false);
      expect(res2.body.message).toContain("Duplicate transfer reference");
    });

    it("10. Should return normalized failure response when provider rejects transfer", async () => {
      mockFlwClient.request.mockRejectedValueOnce(new Error("Unable to execute transfer"));

      const res = await request(app)
        .post("/api/flutterwave/transfer")
        .set("Authorization", `Bearer ${validJwtToken}`)
        .set("X-Session-ID", "test-session-id-123")
        .send(validPayload);

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("Unable to execute transfer");
    });
  });
});
