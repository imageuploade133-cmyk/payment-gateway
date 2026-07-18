import request from "supertest";
import app from "../app";
import { getFlutterwaveClient } from "../providers/flutterwave";

// Mock the Flutterwave client singleton helper
jest.mock("../providers/flutterwave", () => {
  const mClient = {
    request: jest.fn(),
  };
  return {
    getFlutterwaveClient: () => mClient,
  };
});

const mockFlwClient = getFlutterwaveClient() as jest.Mocked<any>;

describe("Flutterwave Account Resolution Endpoint Tests", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("POST /api/flutterwave/resolve-account - Request Validation (Zod)", () => {
    it("should return HTTP 400 with a descriptive validation error if account_number is missing", async () => {
      const res = await request(app)
        .post("/api/flutterwave/resolve-account")
        .send({ bank_code: "044" });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("Validation Error");
    });

    it("should return HTTP 400 if account_number contains non-digits", async () => {
      const res = await request(app)
        .post("/api/flutterwave/resolve-account")
        .send({ account_number: "01234abc89", bank_code: "044" });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("Validation Error");
    });

    it("should return HTTP 400 if bank_code contains non-digits", async () => {
      const res = await request(app)
        .post("/api/flutterwave/resolve-account")
        .send({ account_number: "0123456789", bank_code: "abc" });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("Validation Error");
    });
  });

  describe("POST /api/flutterwave/resolve-account - Execution", () => {
    it("should return normalized success object with HTTP 200 when provider successfully resolves", async () => {
      // Mock successful response from Flutterwave API
      mockFlwClient.request.mockResolvedValue({
        status: "success",
        message: "Account details resolved",
        data: {
          account_number: "0123456789",
          account_name: "SARAH SMITH CONNOR",
        },
      });

      const res = await request(app)
        .post("/api/flutterwave/resolve-account")
        .send({ account_number: "0123456789", bank_code: "044" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        account_name: "SARAH SMITH CONNOR",
        account_number: "0123456789",
        bank_code: "044",
      });
      expect(mockFlwClient.request).toHaveBeenCalledWith("post", "/accounts/resolve", {
        account_number: "0123456789",
        account_bank: "044",
      });
    });

    it("should return clean mapped failure and HTTP 400 when provider rejects details", async () => {
      // Mock failure response from Flutterwave (e.g. invalid account details)
      mockFlwClient.request.mockRejectedValue(new Error("Unable to resolve account"));

      const res = await request(app)
        .post("/api/flutterwave/resolve-account")
        .send({ account_number: "9999999999", bank_code: "044" });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        success: false,
        message: "Unable to verify account details. Please check the bank and account number.",
      });
    });

    it("should return HTTP 200 and include request IDs in X-Request-ID response header", async () => {
      mockFlwClient.request.mockResolvedValue({
        status: "success",
        data: {
          account_number: "0123456789",
          account_name: "SARAH SMITH CONNOR",
        },
      });

      const customRequestId = "test-uuid-9999-8888";
      const res = await request(app)
        .post("/api/flutterwave/resolve-account")
        .set("X-Request-ID", customRequestId)
        .send({ account_number: "0123456789", bank_code: "044" });

      expect(res.status).toBe(200);
      expect(res.headers["x-request-id"]).toBe(customRequestId);
    });
  });
});
