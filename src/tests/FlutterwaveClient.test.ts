import { FlutterwaveClient, FlutterwaveClientConfig } from "../providers/flutterwave/FlutterwaveClient";
import axios from "axios";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe("FlutterwaveClient Tests", () => {
  let client: FlutterwaveClient;
  let mockAxiosInstance: any;
  const config: FlutterwaveClientConfig = {
    baseUrl: "https://api.flutterwave.com/v3",
    secretKey: "FLWSECK_TEST-123456789",
    webhookSecret: "test-webhook-secret-123",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockAxiosInstance = {
      request: jest.fn(),
      interceptors: {
        request: { use: jest.fn() },
        response: { use: jest.fn() },
      },
    };

    mockedAxios.create.mockReturnValue(mockAxiosInstance);
    client = new FlutterwaveClient(config);
  });

  describe("Constructor and Setup", () => {
    it("should instantiate the client with correct config", () => {
      expect(client).toBeDefined();
      expect(mockedAxios.create).toHaveBeenCalledWith({
        baseURL: config.baseUrl,
        timeout: 15000,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.secretKey}`,
        },
      });
    });
  });

  describe("verifyWebhookSignature", () => {
    it("should return true when signature matches secret", () => {
      const isValid = client.verifyWebhookSignature("test-webhook-secret-123", "{}");
      expect(isValid).toBe(true);
    });

    it("should return false when signature does not match secret", () => {
      const isValid = client.verifyWebhookSignature("wrong-secret", "{}");
      expect(isValid).toBe(false);
    });

    it("should return false when signature header is missing", () => {
      const isValid = client.verifyWebhookSignature(null, "{}");
      expect(isValid).toBe(false);
    });
  });
});
