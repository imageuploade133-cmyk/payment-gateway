import request from "supertest";
import app from "../app";
import { getFlutterwaveClient } from "../providers/flutterwave";
import { InMemoryIdempotency } from "../services/transferService";
import { env } from "../config/env";

// Mock Firebase Admin SDK
const mockFirestoreStore: Record<string, any> = {};

jest.mock("firebase-admin/app", () => ({
  getApps: jest.fn(() => [{ name: "[DEFAULT]" }]),
  initializeApp: jest.fn(),
  cert: jest.fn(),
}));

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

// Mock Flutterwave Client
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

describe("E-Global to Payment Gateway Transfer Security Integration Tests", () => {
  let validPayload: any;
  const targetUid = "eglobal-user-uid-100";
  const validSessionId = "session-token-abc-123";
  const mockFirebaseToken = "header.payload.signature_mock_firebase_id_token";

  beforeEach(() => {
    jest.clearAllMocks();
    mockFirestoreStore[`users/${targetUid}`] = {
      uid: targetUid,
      balance: 500000,
      activeSessionId: validSessionId,
    };
    mockFirestoreStore[`wallets/${targetUid}_NGN`] = {
      userId: targetUid,
      balance: 500000,
    };

    const idempotency = InMemoryIdempotency.getInstance();
    (idempotency as any).cache.clear();

    const uniqueRef = `trf-eglobal-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
    validPayload = {
      amount: 25000,
      account_number: "0123456789",
      account_bank: "044",
      beneficiary_name: "Ahmadu Bello",
      currency: "NGN",
      narration: "E-Global Vendor Payment",
      reference: uniqueRef,
    };
  });

  it("1. Real E-Global request with valid Firebase ID Token + X-Session-ID should execute transfer successfully", async () => {
    mockVerifyIdToken.mockResolvedValueOnce({
      uid: targetUid,
      email: "ahmadu@e-tech-hub.com",
    });

    mockFlwClient.request.mockResolvedValueOnce({
      status: "success",
      message: "Transfer queued",
      data: { id: 778899, status: "NEW" },
    });

    const res = await request(app)
      .post("/api/flutterwave/transfer")
      .set("Authorization", `Bearer ${mockFirebaseToken}`)
      .set("X-Session-ID", validSessionId)
      .send(validPayload);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockVerifyIdToken).toHaveBeenCalledWith(mockFirebaseToken);
    expect(mockFlwClient.request).toHaveBeenCalledWith(
      "post",
      "/transfers",
      expect.objectContaining({
        reference: validPayload.reference,
        amount: 25000,
      })
    );

    // Verify transfer record saved with correct user ID
    const savedTransfer = mockFirestoreStore[`transfers/${validPayload.reference}`];
    expect(savedTransfer).toBeDefined();
    expect(savedTransfer.userId).toBe(targetUid);
  });

  it("2. Missing Authorization header should be rejected with HTTP 401 and NEVER call Flutterwave", async () => {
    const res = await request(app)
      .post("/api/flutterwave/transfer")
      .send(validPayload);

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(mockFlwClient.request).not.toHaveBeenCalled();
  });

  it("3. Invalid/Expired Firebase ID token should return HTTP 401 Unauthorized and NEVER call Flutterwave", async () => {
    mockVerifyIdToken.mockRejectedValueOnce(new Error("Firebase ID token has expired"));

    const res = await request(app)
      .post("/api/flutterwave/transfer")
      .set("Authorization", `Bearer ${mockFirebaseToken}`)
      .set("X-Session-ID", validSessionId)
      .send(validPayload);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("REVOKED_SESSION");
    expect(mockFlwClient.request).not.toHaveBeenCalled();
  });

  it("4. Missing X-Session-ID header on transfer request should return HTTP 401 REVOKED_SESSION and NEVER call Flutterwave", async () => {
    mockVerifyIdToken.mockResolvedValueOnce({
      uid: targetUid,
    });

    const res = await request(app)
      .post("/api/flutterwave/transfer")
      .set("Authorization", `Bearer ${mockFirebaseToken}`)
      .send(validPayload);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("REVOKED_SESSION");
    expect(res.body.message).toContain("Missing session ID");
    expect(mockFlwClient.request).not.toHaveBeenCalled();
  });

  it("5. Session mismatch in Firestore should return HTTP 401 REVOKED_SESSION and NEVER call Flutterwave", async () => {
    mockVerifyIdToken.mockResolvedValueOnce({
      uid: targetUid,
    });

    const res = await request(app)
      .post("/api/flutterwave/transfer")
      .set("Authorization", `Bearer ${mockFirebaseToken}`)
      .set("X-Session-ID", "invalid-mismatched-session-id")
      .send(validPayload);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("REVOKED_SESSION");
    expect(res.body.message).toContain("signed in on another device");
    expect(mockFlwClient.request).not.toHaveBeenCalled();
  });

  it("6. Forged client-supplied body userId/uid on API key request should be rejected with HTTP 401 and NEVER call Flutterwave", async () => {
    const forgedPayload = {
      ...validPayload,
      userId: targetUid,
      uid: targetUid,
    };

    const res = await request(app)
      .post("/api/flutterwave/transfer")
      .set("X-API-Key", testApiKey)
      .send(forgedPayload);

    expect(res.status).toBe(401);
    expect(res.body.message).toContain("Authentication Error");
    expect(mockFlwClient.request).not.toHaveBeenCalled();
  });

  it("7. JWT fallback token signed with JWT_SECRET should be rejected for transfer route", async () => {
    const jwt = require("jsonwebtoken");
    const nonFirebaseJwt = jwt.sign({ uid: targetUid, sub: targetUid }, env.JWT_SECRET);

    const res = await request(app)
      .post("/api/flutterwave/transfer")
      .set("Authorization", `Bearer ${nonFirebaseJwt}`)
      .set("X-Session-ID", validSessionId)
      .send(validPayload);

    expect(res.status).toBe(401);
    expect(mockFlwClient.request).not.toHaveBeenCalled();
  });

  it("8. User record with missing activeSessionId in Firestore should be rejected with HTTP 401 REVOKED_SESSION", async () => {
    mockVerifyIdToken.mockResolvedValueOnce({
      uid: targetUid,
    });

    // Remove activeSessionId from Firestore user record
    mockFirestoreStore[`users/${targetUid}`] = {
      uid: targetUid,
      balance: 500000,
      activeSessionId: null,
    };

    const res = await request(app)
      .post("/api/flutterwave/transfer")
      .set("Authorization", `Bearer ${mockFirebaseToken}`)
      .set("X-Session-ID", validSessionId)
      .send(validPayload);

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("REVOKED_SESSION");
    expect(mockFlwClient.request).not.toHaveBeenCalled();
  });
});
