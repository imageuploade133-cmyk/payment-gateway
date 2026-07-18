import request from "supertest";
import app from "../app";
import jwt from "jsonwebtoken";
import { env } from "../config/env";

describe("Gateway Security & Authentication Tests (Phase 6)", () => {
  const getValidApiKey = () => env.GATEWAY_API_KEYS[0];
  const invalidApiKey = "wrong_api_key_abc";

  describe("Public Endpoints", () => {
    it("should allow GET /health without any authentication header", async () => {
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: "ok" });
    });
  });

  describe("S2S Protected Endpoints - API Key Authentication", () => {
    it("should return HTTP 401 Unauthorized if authentication header is missing", async () => {
      const res = await request(app)
        .post("/api/flutterwave/resolve-account")
        .send({ account_number: "0123456789", bank_code: "044" });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("Missing authentication credentials");
    });

    it("should allow request if valid API Key is provided via X-API-Key header", async () => {
      const res = await request(app)
        .post("/api/flutterwave/resolve-account")
        .set("X-API-Key", getValidApiKey())
        .send({ account_number: "0123456789", bank_code: "044" });

      // If authorized, it passes to the controller where Zod/Provider handles execution
      expect(res.status).not.toBe(401);
    });

    it("should allow request if valid API Key is provided via Authorization Bearer header", async () => {
      const res = await request(app)
        .post("/api/flutterwave/resolve-account")
        .set("Authorization", `Bearer ${getValidApiKey()}`)
        .send({ account_number: "0123456789", bank_code: "044" });

      expect(res.status).not.toBe(401);
    });

    it("should reject request with HTTP 401 if invalid API Key is provided via X-API-Key header", async () => {
      const res = await request(app)
        .post("/api/flutterwave/resolve-account")
        .set("X-API-Key", invalidApiKey)
        .send({ account_number: "0123456789", bank_code: "044" });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("Invalid API Key");
    });

    it("should reject request with HTTP 401 if invalid API Key is provided via Authorization Bearer", async () => {
      const res = await request(app)
        .post("/api/flutterwave/resolve-account")
        .set("Authorization", `Bearer ${invalidApiKey}`)
        .send({ account_number: "0123456789", bank_code: "044" });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("Invalid API Key");
    });
  });

  describe("S2S Protected Endpoints - JWT Authentication (Extensible design)", () => {
    it("should allow request if valid JWT is provided via Authorization Bearer", async () => {
      const payload = { sub: "vercel-client", role: "microservice-client" };
      const token = jwt.sign(payload, env.JWT_SECRET, { expiresIn: "1h" });

      const res = await request(app)
        .post("/api/flutterwave/resolve-account")
        .set("Authorization", `Bearer ${token}`)
        .send({ account_number: "0123456789", bank_code: "044" });

      expect(res.status).not.toBe(401);
    });

    it("should reject request with HTTP 401 if invalid/forged JWT is provided", async () => {
      const forgedToken = jwt.sign({ sub: "attacker" }, "wrong_secret_key");

      const res = await request(app)
        .post("/api/flutterwave/resolve-account")
        .set("Authorization", `Bearer ${forgedToken}`)
        .send({ account_number: "0123456789", bank_code: "044" });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("Invalid or expired authentication token");
    });
  });

  describe("Request Payload Security", () => {
    it("should reject requests exceeding strict size limits (10kb) to defend against memory exhaustion", async () => {
      // Create a giant string payload of ~50kb size
      const hugeString = "X".repeat(50 * 1024);

      const res = await request(app)
        .post("/api/flutterwave/resolve-account")
        .set("X-API-Key", getValidApiKey())
        .send({ data: hugeString });

      // Express body parser rejects payload too large with HTTP 413
      expect(res.status).toBe(413);
    });
  });
});
