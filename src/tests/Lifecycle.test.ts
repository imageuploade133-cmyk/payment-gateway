import request from "supertest";
import app from "../app";
import { getFlutterwaveClient } from "../providers/flutterwave";
import { InMemoryIdempotency } from "../services/transferService";
import { env } from "../config/env";

// Mock the Flutterwave client singleton helper
jest.mock("../providers/flutterwave", () => {
  const mClient = {
    request: jest.fn(),
    verifyWebhookSignature: jest.fn(),
  };
  return {
    getFlutterwaveClient: () => mClient,
  };
});

const mockFlwClient = getFlutterwaveClient() as jest.Mocked<any>;

// Resolve API Key dynamically to avoid evaluations order issues in Jest
const getTestApiKey = () => env.GATEWAY_API_KEYS[0];

describe("Flutterwave Payment Lifecycle Endpoints (Phase 5)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const idempotency = InMemoryIdempotency.getInstance();
    (idempotency as any).cache.clear();
  });

  describe("POST /api/flutterwave/create-virtual-account - Virtual Account Creation", () => {
    const validVirtualAccountPayload = {
      email: "test-user@e-tech-hub.com",
      is_permanent: true,
      bvn: "22222222222",
      tx_ref: "va-user-123-999",
      phonenumber: "08012345678",
      firstname: "Sarah",
      lastname: "Connor",
    };

    it("should return HTTP 400 with validation error if email is invalid", async () => {
      const res = await request(app)
        .post("/api/flutterwave/create-virtual-account")
        .set("X-API-Key", getTestApiKey())
        .send({ ...validVirtualAccountPayload, email: "invalid-email" });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("Validation Error");
    });

    it("should return HTTP 200 and normalized virtual account details on successful provider provisioning", async () => {
      mockFlwClient.request.mockResolvedValue({
        status: "success",
        data: {
          account_number: "9981452901",
          bank_name: "Wema Bank",
          account_name: "Sarah Connor - E-Tech",
          currency: "NGN",
        },
      });

      const res = await request(app)
        .post("/api/flutterwave/create-virtual-account")
        .set("X-API-Key", getTestApiKey())
        .send(validVirtualAccountPayload);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        status: "success",
        alreadyExists: false,
        isExisting: false,
        is_existing: false,
        accountNumber: "9981452901",
        account_number: "9981452901",
        accountName: "Sarah Connor - E-Tech",
        account_name: "Sarah Connor - E-Tech",
        bankName: "Wema Bank",
        bank_name: "Wema Bank",
        bankCode: "035",
        bank_code: "035",
        currency: "NGN",
        reference: "va-user-123-999",
        kycStatus: "VERIFIED",
        bvn: null,
        nin: null,
        data: {
          account_number: "9981452901",
          account_name: "Sarah Connor - E-Tech",
          bank_name: "Wema Bank",
          bank_code: "035",
          reference: "va-user-123-999",
          is_existing: false,
          kycStatus: "VERIFIED",
          bvn: null,
          nin: null,
        }
      });
      expect(mockFlwClient.request).toHaveBeenCalledWith("post", "/virtual-account-numbers", {
        email: validVirtualAccountPayload.email,
        is_permanent: validVirtualAccountPayload.is_permanent,
        bvn: validVirtualAccountPayload.bvn,
        tx_ref: validVirtualAccountPayload.tx_ref,
        phonenumber: validVirtualAccountPayload.phonenumber,
        firstname: validVirtualAccountPayload.firstname,
        lastname: validVirtualAccountPayload.lastname,
      }, undefined);
    });
  });

  describe("POST /api/flutterwave/verify - Payment Verification", () => {
    it("should return HTTP 400 validation error if transaction_id is missing", async () => {
      const res = await request(app)
        .post("/api/flutterwave/verify")
        .set("X-API-Key", getTestApiKey())
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("Validation Error");
    });

    it("should return HTTP 200 and normalized details on successful verification", async () => {
      mockFlwClient.request.mockResolvedValue({
        status: "success",
        data: {
          id: 567890,
          status: "successful",
          amount: 2500,
          currency: "NGN",
          tx_ref: "flw-tx-999-12345",
          customer: {
            name: "John Doe",
            email: "john@doe.com",
            phone_number: "09088887777",
          },
        },
      });

      const res = await request(app)
        .post("/api/flutterwave/verify")
        .set("X-API-Key", getTestApiKey())
        .send({ transaction_id: "567890" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual(expect.objectContaining({
        success: true,
        status: "successful",
        amount: 2500,
        currency: "NGN",
        reference: "flw-tx-999-12345",
        flw_id: "567890",
        customer: {
          name: "John Doe",
          email: "john@doe.com",
          phone: "09088887777",
        },
      }));
    });
  });

  describe("POST /api/flutterwave/webhook - Webhook Processing", () => {
    it("should reject with HTTP 401 if signature validation fails", async () => {
      mockFlwClient.verifyWebhookSignature.mockReturnValue(false);

      const res = await request(app)
        .post("/api/flutterwave/webhook")
        .set("verif-hash", "invalid-hash-here")
        .send({
          event: "charge.completed",
          data: { id: 112233, tx_ref: "flw-tx-888-777", amount: 1000, currency: "NGN" },
        });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("Unauthorized signature hash mismatch");
    });

    it("should process valid signature with charge.completed successfully and return HTTP 200", async () => {
      mockFlwClient.verifyWebhookSignature.mockReturnValue(true);

      const res = await request(app)
        .post("/api/flutterwave/webhook")
        .set("verif-hash", "valid-signature-hash")
        .send({
          event: "charge.completed",
          data: { id: 11223311, tx_ref: "flw-tx-888-777-single", amount: 1000, currency: "NGN" },
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain("Webhook payload verified");
    });

    it("should implement duplicate transaction defense and avoid processing same transaction twice", async () => {
      mockFlwClient.verifyWebhookSignature.mockReturnValue(true);

      const duplicatePayload = {
        event: "charge.completed",
        data: { id: 99887766, tx_ref: "flw-tx-dup-test-1", amount: 1000, currency: "NGN" },
      };

      // First webhook
      const res1 = await request(app)
        .post("/api/flutterwave/webhook")
        .set("verif-hash", "valid-signature-hash")
        .send(duplicatePayload);
      expect(res1.status).toBe(200);

      // Replayed webhook with identical transaction ID
      const res2 = await request(app)
        .post("/api/flutterwave/webhook")
        .set("verif-hash", "valid-signature-hash")
        .send(duplicatePayload);

      expect(res2.status).toBe(200);
      expect(res2.body.message).toContain("Webhook already processed successfully");
    });
  });
});
