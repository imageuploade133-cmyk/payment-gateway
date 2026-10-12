import request from "supertest";
import app from "../app";
import { getPaystackClient } from "../providers/paystack";
import { InMemoryIdempotency } from "../services/transferService";
import { FirestoreIdempotency } from "../services/firestoreIdempotency";
import { env } from "../config/env";

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
        create: async (docRef: any, data: any) => docRef.set(data),
      };
      return cb(fakeTx);
    }),
  },
}));

// Mock Paystack client helper
jest.mock("../providers/paystack", () => {
  const mClient = {
    request: jest.fn(),
    verifyWebhookSignature: jest.fn(),
  };
  return {
    getPaystackClient: () => mClient,
  };
});

const mockPstkClient = getPaystackClient() as jest.Mocked<any>;
const getTestApiKey = () => env.GATEWAY_API_KEYS[0];

describe("Paystack Provider Integration Tests (Phase 8)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const key in mockFirestoreStore) {
      delete mockFirestoreStore[key];
    }
    const idempotency = InMemoryIdempotency.getInstance();
    (idempotency as any).cache.clear();
    FirestoreIdempotency.getInstance().clearCache();
  });

  describe("POST /api/paystack/resolve-account - Account Resolution", () => {
    it("should return HTTP 200 with resolved account details when successful", async () => {
      mockPstkClient.request.mockResolvedValueOnce({
        status: true,
        data: {
          account_name: "JOHN PAYSTACK DOE",
          account_number: "0123456789",
        },
      });

      const res = await request(app)
        .post("/api/paystack/resolve-account")
        .set("X-API-Key", getTestApiKey())
        .send({ account_number: "0123456789", bank_code: "058" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        account_name: "JOHN PAYSTACK DOE",
        account_number: "0123456789",
        bank_code: "058",
      });
    });

    it("should return HTTP 400 when account resolution fails on provider side", async () => {
      mockPstkClient.request.mockRejectedValueOnce(new Error("Resolution failed"));

      const res = await request(app)
        .post("/api/paystack/resolve-account")
        .set("X-API-Key", getTestApiKey())
        .send({ account_number: "0123456789", bank_code: "058" });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("Unable to verify account details");
    });
  });

  describe("POST /api/paystack/transfer - Outward Transfers Security & Execution", () => {
    const targetUid = "pstk-user-uid-555";
    const validSessionId = "session-token-pstk-777";
    const mockFirebaseToken = "header.payload.signature_mock_firebase_id_token";

    let validTransferPayload: any;

    beforeEach(() => {
      mockFirestoreStore[`users/${targetUid}`] = {
        uid: targetUid,
        balance: 500000,
        activeSessionId: validSessionId,
      };
      mockFirestoreStore[`wallets/${targetUid}_NGN`] = {
        userId: targetUid,
        balance: 500000,
      };

      const uniqueRef = `salary-pstk-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
      validTransferPayload = {
        amount: 4000,
        account_number: "0123456789",
        bank_code: "058",
        account_name: "JOHN PAYSTACK DOE",
        currency: "NGN",
        narration: "E-Tech Salary",
        reference: uniqueRef,
      };
    });


    it("should reject API-key-only requests with HTTP 401 and NEVER call Paystack", async () => {
      const res = await request(app)
        .post("/api/paystack/transfer")
        .set("X-API-Key", getTestApiKey())
        .send(validTransferPayload);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("Authentication Error");
      expect(mockPstkClient.request).not.toHaveBeenCalled();
    });

    it("should reject forged body UIDs on API key requests with HTTP 401 and NEVER call Paystack", async () => {
      const forgedPayload = {
        ...validTransferPayload,
        userId: targetUid,
        uid: targetUid,
      };

      const res = await request(app)
        .post("/api/paystack/transfer")
        .set("X-API-Key", getTestApiKey())
        .send(forgedPayload);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("Authentication Error");
      expect(mockPstkClient.request).not.toHaveBeenCalled();
    });

    it("should reject requests missing X-Session-ID header with HTTP 401 REVOKED_SESSION and NEVER call Paystack", async () => {
      mockVerifyIdToken.mockResolvedValueOnce({
        uid: targetUid,
      });

      const res = await request(app)
        .post("/api/paystack/transfer")
        .set("Authorization", `Bearer ${mockFirebaseToken}`)
        .send(validTransferPayload);

      expect(res.status).toBe(401);
      expect(res.body.code).toBe("REVOKED_SESSION");
      expect(mockPstkClient.request).not.toHaveBeenCalled();
    });

    it("should process transfer successfully for valid Firebase token + X-Session-ID", async () => {
      mockVerifyIdToken.mockResolvedValueOnce({
        uid: targetUid,
        email: "pstkuser@e-tech-hub.com",
      });

      // Mock recipient creation
      mockPstkClient.request
        .mockResolvedValueOnce({
          status: true,
          data: { recipient_code: "RCP_12345" },
        })
        // Mock transfer execution
        .mockResolvedValueOnce({
          status: true,
          data: { reference: validTransferPayload.reference, id: 998811, status: "success" },
          message: "Transfer queued",
        });

      const res = await request(app)
        .post("/api/paystack/transfer")
        .set("Authorization", `Bearer ${mockFirebaseToken}`)
        .set("X-Session-ID", validSessionId)
        .send(validTransferPayload);

      if (res.status !== 200) {
        process.stderr.write(`PAYSTACK RES BODY: ${JSON.stringify(res.body)}\n`);
      }
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.provider_reference).toBe(validTransferPayload.reference);
    });
  });

  describe("POST /api/paystack/verify - Payment Verification", () => {
    it("should return verified details on success", async () => {
      mockPstkClient.request.mockResolvedValueOnce({
        status: true,
        data: {
          id: 111122,
          status: "success",
          amount: 500000, // in kobo
          currency: "NGN",
          reference: "pstk-ref-112233",
          customer: {
            first_name: "Jane",
            last_name: "Smith",
            email: "jane@smith.com",
          },
        },
      });

      const res = await request(app)
        .post("/api/paystack/verify")
        .set("X-API-Key", getTestApiKey())
        .send({ transaction_id: "pstk-ref-112233" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        status: "successful",
        amount: 5000,
        currency: "NGN",
        reference: "pstk-ref-112233",
        provider_id: "111122",
        customer: {
          name: "Jane Smith",
          email: "jane@smith.com",
        },
      });
    });
  });

  describe("POST /api/paystack/webhook - Webhook Processing", () => {
    const validWebhookBody = {
      event: "charge.success",
      data: {
        id: 776655,
        reference: "pstk-tx-12345",
        amount: 200000,
      },
    };

    it("should reject invalid signatures with HTTP 401", async () => {
      mockPstkClient.verifyWebhookSignature.mockReturnValue(false);

      const res = await request(app)
        .post("/api/paystack/webhook")
        .set("x-paystack-signature", "invalid-signature")
        .send(validWebhookBody);

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it("should process valid signatures successfully and return HTTP 200", async () => {
      mockPstkClient.verifyWebhookSignature.mockReturnValue(true);

      const res = await request(app)
        .post("/api/paystack/webhook")
        .set("x-paystack-signature", "valid-signature")
        .send(validWebhookBody);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });
});
