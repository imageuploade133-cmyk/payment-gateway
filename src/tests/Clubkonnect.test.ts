import request from "supertest";
import app from "../app";
import axios from "axios";
import { ClubkonnectService } from "../services/clubkonnect.service";
import { clubkonnectConfig } from "../config/clubkonnect";
import { env } from "../config/env";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

const getTestApiKey = () => env.GATEWAY_API_KEYS[0];

describe("Clubkonnect Provider Integration Tests", () => {
  const originalUserId = clubkonnectConfig.USER_ID;
  const originalApiKey = clubkonnectConfig.API_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    // Ensure config is populated for standard tests
    clubkonnectConfig.USER_ID = "mock-user-123";
    clubkonnectConfig.API_KEY = "mock-api-key-456";
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

    it("should throw an error if all 3 attempts fail", async () => {
      mockedAxios.get
        .mockRejectedValueOnce(new Error("Fatal Network Failure"))
        .mockRejectedValueOnce(new Error("Fatal Network Failure"))
        .mockRejectedValueOnce(new Error("Fatal Network Failure"));

      await expect(ClubkonnectService.getWalletBalance("test-req-id-fail"))
        .rejects
        .toThrow("Failed to retrieve wallet balance from Clubkonnect after 3 attempts");

      expect(mockedAxios.get).toHaveBeenCalledTimes(3);
    });

    it("should throw an error if the balance is missing in response", async () => {
      mockedAxios.get.mockResolvedValueOnce({
        status: 200,
        data: {
          date: "2023-10-25 12:00:00",
          id: "12345",
        },
      });

      await expect(ClubkonnectService.getWalletBalance("test-req-id-no-balance"))
        .rejects
        .toThrow("Clubkonnect response does not contain 'balance' field");
    });

    it("should throw an error if the balance cannot be parsed as a float", async () => {
      mockedAxios.get.mockResolvedValueOnce({
        status: 200,
        data: {
          date: "2023-10-25 12:00:00",
          id: "12345",
          balance: "not-a-number",
        },
      });

      await expect(ClubkonnectService.getWalletBalance("test-req-id-nan"))
        .rejects
        .toThrow("Clubkonnect balance value 'not-a-number' is not a valid number.");
    });
  });

  describe("GET /api/vtu/balance", () => {
    it("should return HTTP 200 and wallet balance on success", async () => {
      mockedAxios.get.mockResolvedValueOnce({
        status: 200,
        data: {
          date: "2023-10-25 12:00:00",
          id: "12345",
          balance: "7500",
        },
      });

      const res = await request(app)
        .get("/api/vtu/balance")
        .set("X-API-Key", getTestApiKey());

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        provider: "Clubkonnect",
        balance: 7500,
      });
    });

    it("should return HTTP 401 when request is unauthorized", async () => {
      const res = await request(app)
        .get("/api/vtu/balance");

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it("should return HTTP 400 when configurations are missing", async () => {
      clubkonnectConfig.USER_ID = "";

      const res = await request(app)
        .get("/api/vtu/balance")
        .set("X-API-Key", getTestApiKey());

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("Configuration Error: CLUBKONNECT_USER_ID is not configured");
    });

    it("should return HTTP 500 when API call fails", async () => {
      mockedAxios.get
        .mockRejectedValueOnce(new Error("Connection Timeout"))
        .mockRejectedValueOnce(new Error("Connection Timeout"))
        .mockRejectedValueOnce(new Error("Connection Timeout"));

      const res = await request(app)
        .get("/api/vtu/balance")
        .set("X-API-Key", getTestApiKey());

      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toContain("Connection Timeout");
    });
  });
});
