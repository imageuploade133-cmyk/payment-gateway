import request from "supertest";
import app from "../app";
import { getPaystackClient } from "../providers/paystack";
import { InMemoryIdempotency } from "../services/transferService";
import { env } from "../config/env";

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
    const idempotency = InMemoryIdempotency.getInstance();
    (idempotency as any).cache.clear();
  });

  describe("POST /api/paystack/resolve-account - Account Resolution", () => {
    it("should return HTTP 200 with resolved account details when successful", async () => {
      mockPstkClient.request.mockResolvedValue({
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
      mockPstkClient.request.mockRejectedValue(new Error("Resolution failed"));

      const res = await request(app)
        .post("/api/paystack/resolve-account")
        .set("X-API-Key", getTestApiKey())
        .send({ account_number: "0123456789", bank_code: "058" });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("Unable to verify account details");
    });
  });

  describe("POST /api/paystack/transfer - Outward Transfers", () => {
    const validTransferPayload = {
      amount: 4000,
      account_number: "0123456789",
      bank_code: "058",
      account_name: "JOHN PAYSTACK DOE",
      currency: "NGN",
      narration: "E-Tech Salary",
      reference: "salary-pstk-001",
    };

    it("should process transfer successfully", async () => {
      // Mock recipient creation
      mockPstkClient.request
        .mockResolvedValueOnce({
          status: true,
          data: { recipient_code: "RCP_12345" },
        })
        // Mock transfer execution
        .mockResolvedValueOnce({
          status: true,
          data: { reference: "salary-pstk-001", id: 998811, status: "success" },
          message: "Transfer queued",
        });

      const res = await request(app)
        .post("/api/paystack/transfer")
        .set("X-API-Key", getTestApiKey())
        .send(validTransferPayload);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.provider_reference).toBe("salary-pstk-001");
    });
  });

  describe("POST /api/paystack/verify - Payment Verification", () => {
    it("should return verified details on success", async () => {
      mockPstkClient.request.mockResolvedValue({
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
