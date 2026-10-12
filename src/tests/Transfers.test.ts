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

describe("Flutterwave Outward Bank Transfer Endpoint Authentication Tests", () => {
  let validPayload: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFirestoreStore["users/test-user-id"] = { balance: 100000 };
    mockFirestoreStore["wallets/test-user-id_NGN"] = { balance: 100000 };

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

  it("1. Valid API key with missing user identity should be rejected with 401 and NEVER call Flutterwave", async () => {
    const res = await request(app)
      .post("/api/flutterwave/transfer")
      .set("X-API-Key", testApiKey)
      .send(validPayload);

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain("Authentication Error");
    expect(mockFlwClient.request).not.toHaveBeenCalled();
  });

  it("2. Invalid API key should be rejected with 401 and NEVER call Flutterwave", async () => {
    const res = await request(app)
      .post("/api/flutterwave/transfer")
      .set("X-API-Key", "invalid-api-key-999")
      .set("X-User-UID", "test-user-id")
      .send(validPayload);

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain("Unauthorized");
    expect(mockFlwClient.request).not.toHaveBeenCalled();
  });

  it("3. Valid API key with server-verified user ID header should process transfer successfully", async () => {
    mockFlwClient.request.mockResolvedValueOnce({
      status: "success",
      message: "Transfer queued",
      data: { id: 887766, status: "NEW" },
    });

    const res = await request(app)
      .post("/api/flutterwave/transfer")
      .set("X-API-Key", testApiKey)
      .set("X-User-UID", "test-user-id")
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

  it("4. Client-supplied forged userId in request body without verified auth identity should be rejected with 401", async () => {
    const forgedPayload = {
      ...validPayload,
      userId: "forged-admin-user-id",
      uid: "forged-admin-user-id",
    };

    const res = await request(app)
      .post("/api/flutterwave/transfer")
      .set("X-API-Key", testApiKey)
      .send(forgedPayload);

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain("Authentication Error");
    expect(mockFlwClient.request).not.toHaveBeenCalled();
  });

  it("5. Should reject duplicate transfer reference if sent twice (Idempotency check)", async () => {
    mockFlwClient.request.mockResolvedValue({
      status: "success",
      message: "Transfer queued",
      data: { id: 887766, status: "NEW" },
    });

    const res1 = await request(app)
      .post("/api/flutterwave/transfer")
      .set("X-API-Key", testApiKey)
      .set("X-User-UID", "test-user-id")
      .send(validPayload);
    expect(res1.status).toBe(200);

    // Send identical transfer reference again
    const res2 = await request(app)
      .post("/api/flutterwave/transfer")
      .set("X-API-Key", testApiKey)
      .set("X-User-UID", "test-user-id")
      .send(validPayload);

    expect(res2.status).toBe(400);
    expect(res2.body.success).toBe(false);
    expect(res2.body.message).toContain("Duplicate transfer reference");
  });
});
