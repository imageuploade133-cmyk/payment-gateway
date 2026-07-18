import axios, { AxiosInstance, AxiosError, InternalAxiosRequestConfig, AxiosResponse } from "axios";
import { PaymentProvider } from "../PaymentProvider";
import { FlutterwaveConfig } from "./FlutterwaveConfig";
import { FlutterwaveError } from "./FlutterwaveError";
import logger from "../../config/logger";

export class FlutterwaveClient implements PaymentProvider {
  public readonly name = "flutterwave";
  private readonly client: AxiosInstance;
  private readonly config: FlutterwaveConfig;

  constructor(config: FlutterwaveConfig) {
    this.config = {
      timeoutMs: 15000,
      maxRetries: 3,
      ...config,
    };

    this.client = axios.create({
      baseURL: this.config.baseUrl,
      timeout: this.config.timeoutMs,
      headers: {
        "Content-Type": "application/json",
      },
    });

    this.setupInterceptors();
  }

  /**
   * Configures request/response interceptors for authentication, structured logging, and retries.
   */
  private setupInterceptors(): void {
    // 1. Request Interceptor: Authentication & Logging
    this.client.interceptors.request.use(
      (reqConfig: InternalAxiosRequestConfig) => {
        // Set bearer token authentication securely
        reqConfig.headers.Authorization = `Bearer ${this.config.secretKey}`;

        logger.debug(
          `[FlutterwaveClient] Outgoing Request: ${reqConfig.method?.toUpperCase()} ${reqConfig.url}`
        );
        return reqConfig;
      },
      (error: any) => {
        logger.error(`[FlutterwaveClient] Request Setup Error: ${error.message}`);
        return Promise.reject(error);
      }
    );

    // 2. Response Interceptor: Structured Logging, Error Mapping & Transient Retry handling
    this.client.interceptors.response.use(
      (response: AxiosResponse) => {
        logger.debug(
          `[FlutterwaveClient] Response Success: ${response.config.method?.toUpperCase()} ${response.config.url} | Status: ${response.status}`
        );
        return response;
      },
      async (error: any) => {
        const reqConfig = error.config;

        // Check if error is a transient failure worthy of retrying
        const isTransient = this.isTransientFailure(error);
        const retryCount = reqConfig ? (reqConfig.metadata?.retryCount || 0) : 0;

        if (isTransient && reqConfig && retryCount < (this.config.maxRetries || 3)) {
          reqConfig.metadata = reqConfig.metadata || {};
          reqConfig.metadata.retryCount = retryCount + 1;

          // Exponential backoff delay
          const backoffDelay = Math.pow(2, retryCount) * 1000;
          logger.warn(
            `[FlutterwaveClient] Transient failure detected (${error.message || "Network Error"}). Retrying request: ${reqConfig.method?.toUpperCase()} ${reqConfig.url}. Attempt ${reqConfig.metadata.retryCount} of ${this.config.maxRetries}. Delaying for ${backoffDelay}ms...`
          );

          await new Promise((resolve) => setTimeout(resolve, backoffDelay));
          return this.client(reqConfig);
        }

        // Map and reject with a normalized FlutterwaveError
        const flwError = FlutterwaveError.fromError(error);
        logger.error(
          `[FlutterwaveClient] Request Failed: ${reqConfig?.method?.toUpperCase()} ${reqConfig?.url} | Status: ${flwError.statusCode} | Error: ${flwError.message}`
        );
        return Promise.reject(flwError);
      }
    );
  }

  /**
   * Checks if the error represents a transient network/server error suitable for retrying.
   */
  private isTransientFailure(error: any): boolean {
    // If there is no response, it's likely a network failure or gateway timeout
    if (!error.response) {
      return true;
    }

    const status = error.response.status;
    // Retry on standard transient status codes: Rate Limit (429) or Server Errors (502, 503, 504)
    return status === 429 || status === 502 || status === 503 || status === 504;
  }

  /**
   * Generic API call wrapper that wraps Axios calls and forces FlutterwaveError mapping.
   */
  public async request<T = any>(
    method: "get" | "post" | "put" | "delete",
    endpoint: string,
    data?: any,
    headers?: Record<string, string>
  ): Promise<T> {
    try {
      const response = await this.client.request<T>({
        method,
        url: endpoint,
        data,
        headers,
      });
      return response.data;
    } catch (error: any) {
      // Re-throw mapped error (setupInterceptors maps AxiosError into FlutterwaveError)
      throw error;
    }
  }

  /**
   * Provider health check endpoint to check connectivity and credential validity.
   * Hits the standard banks listing endpoint which requires zero payload.
   */
  public async healthCheck(): Promise<boolean> {
    try {
      logger.info("[FlutterwaveClient] Executing payment provider healthCheck...");
      // Fetch Nigerian banks list as a lightweight credential verification query
      const response = await this.request("get", "/banks/NG");
      const success = response && response.status === "success";
      logger.info(`[FlutterwaveClient] healthCheck results: ${success ? "SUCCESS" : "FAILED"}`);
      return success;
    } catch (error: any) {
      logger.error(`[FlutterwaveClient] healthCheck crashed: ${error.message}`);
      return false;
    }
  }
}
export default FlutterwaveClient;
