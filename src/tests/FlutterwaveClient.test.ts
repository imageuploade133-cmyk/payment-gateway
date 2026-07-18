import { FlutterwaveClient } from "../providers/flutterwave/FlutterwaveClient";
import { FlutterwaveError } from "../providers/flutterwave/FlutterwaveError";
import axios from "axios";

// Mock axios
jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe("FlutterwaveClient Unit Tests", () => {
  const config = {
    baseUrl: "https://api.flutterwave.com/v3",
    publicKey: "FLWPUBK_TEST-12345",
    secretKey: "FLWSECK_TEST-12345",
    webhookSecret: "flw_wh_secret_12345",
    maxRetries: 2,
  };

  let client: FlutterwaveClient;
  let mockAxiosInstance: any;
  let requestInterceptorSuccess: any;
  let responseInterceptorSuccess: any;
  let responseInterceptorError: any;

  beforeEach(() => {
    jest.clearAllMocks();

    requestInterceptorSuccess = null;
    responseInterceptorSuccess = null;
    responseInterceptorError = null;

    // Create a callable mock function that represents axios instance
    mockAxiosInstance = jest.fn();
    mockAxiosInstance.defaults = { headers: {} };
    mockAxiosInstance.interceptors = {
      request: {
        use: jest.fn((successFn, errorFn) => {
          requestInterceptorSuccess = successFn;
        }),
        eject: jest.fn(),
      },
      response: {
        use: jest.fn((successFn, errorFn) => {
          responseInterceptorSuccess = successFn;
          responseInterceptorError = errorFn;
        }),
        eject: jest.fn(),
      },
    };
    mockAxiosInstance.request = jest.fn();

    mockedAxios.create.mockReturnValue(mockAxiosInstance);

    client = new FlutterwaveClient(config);
  });

  describe("Constructor and Setup", () => {
    it("should instantiate the client with correct config and setup interceptors", () => {
      expect(client).toBeDefined();
      expect(client.name).toBe("flutterwave");
      expect(mockedAxios.create).toHaveBeenCalledWith({
        baseURL: config.baseUrl,
        timeout: 15000,
        headers: { "Content-Type": "application/json" },
      });
      expect(mockAxiosInstance.interceptors.request.use).toHaveBeenCalled();
      expect(mockAxiosInstance.interceptors.response.use).toHaveBeenCalled();
    });
  });

  describe("Interceptors Behavior", () => {
    it("should add Authorization header in request interceptor", () => {
      const mockReqConfig: any = { headers: {} };
      const modifiedConfig = requestInterceptorSuccess(mockReqConfig);
      expect(modifiedConfig.headers.Authorization).toBe(`Bearer ${config.secretKey}`);
    });

    it("should log and return response on response success interceptor", () => {
      const mockRes: any = { status: 200, config: { method: "get", url: "/banks" } };
      const result = responseInterceptorSuccess(mockRes);
      expect(result).toBe(mockRes);
    });

    it("should map Axios response error to FlutterwaveError inside interceptor", async () => {
      const axiosError: any = {
        config: { method: "get", url: "/banks" },
        response: {
          status: 400,
          statusText: "Bad Request",
          data: { status: "error", message: "Invalid Bank Code", code: "FLW_ERR" },
        },
      };

      await expect(responseInterceptorError(axiosError)).rejects.toThrow(FlutterwaveError);
    });

    it("should map Axios timeout/network error with no response inside interceptor when retries are exhausted", async () => {
      const axiosError: any = {
        config: { method: "get", url: "/banks", metadata: { retryCount: 2 } },
        request: {},
      };

      await expect(responseInterceptorError(axiosError)).rejects.toThrow("No response received from Flutterwave");
    });

    it("should trigger retry when transient failure is encountered", async () => {
      const axiosError: any = {
        config: { method: "get", url: "/banks", metadata: { retryCount: 0 } },
        request: {},
        message: "Network Error",
      };

      mockAxiosInstance.mockResolvedValue({ data: "retry-success" });

      const retryPromise = responseInterceptorError(axiosError);

      await expect(retryPromise).resolves.toEqual({ data: "retry-success" });
      expect(mockAxiosInstance).toHaveBeenCalledWith({
        method: "get",
        url: "/banks",
        metadata: { retryCount: 1 },
      });
    });
  });

  describe("API Request Execution", () => {
    it("should return data on successful response", async () => {
      const mockResponse = { data: { status: "success", data: "some-data" } };
      mockAxiosInstance.request.mockResolvedValue(mockResponse);

      const result = await client.request("get", "/banks/NG");
      expect(result).toEqual(mockResponse.data);
    });
  });

  describe("Health Check", () => {
    it("should return true if health check is successful", async () => {
      const mockResponse = { data: { status: "success", data: [] } };
      mockAxiosInstance.request.mockResolvedValue(mockResponse);

      const isHealthy = await client.healthCheck();
      expect(isHealthy).toBe(true);
    });

    it("should return false if health check fails or throws", async () => {
      mockAxiosInstance.request.mockRejectedValue(new Error("Network Error"));

      const isHealthy = await client.healthCheck();
      expect(isHealthy).toBe(false);
    });
  });
});
