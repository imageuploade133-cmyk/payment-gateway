import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from "axios";
import logger from "../../config/logger";
import { FlutterwaveError } from "./FlutterwaveError";
import { PaymentProvider } from "../PaymentProvider";

export interface FlutterwaveClientConfig {
  baseUrl: string;
  secretKey: string;
  publicKey?: string;
  webhookSecret?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export class FlutterwaveClient implements PaymentProvider {
  public readonly name = "flutterwave";
  private axiosInstance: AxiosInstance;
  private config: FlutterwaveClientConfig;

  constructor(config: FlutterwaveClientConfig) {
    this.config = {
      timeoutMs: 15000,
      maxRetries: 2,
      ...config,
    };

    if (!this.config.secretKey) {
      throw new Error("FlutterwaveClient initialization failed: secretKey is required.");
    }

    this.axiosInstance = axios.create({
      baseURL: this.config.baseUrl,
      timeout: this.config.timeoutMs,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.secretKey}`,
      },
    });
  }

  public async request<T = any>(
    method: "get" | "post" | "put" | "delete",
    url: string,
    data?: any,
    customHeaders?: Record<string, string>
  ): Promise<T> {
    const maxRetries = this.config.maxRetries || 2;
    let attempt = 0;

    while (true) {
      try {
        const config: AxiosRequestConfig = {
          method,
          url,
          data,
          headers: customHeaders ? { ...customHeaders } : undefined,
        };

        const response: AxiosResponse<T> = await this.axiosInstance.request(config);
        return response.data;
      } catch (error: any) {
        attempt++;

        const isNetworkError = !error.response;
        const statusCode = error.response?.status;
        const isTransientStatus = statusCode === 429 || (statusCode >= 500 && statusCode < 600);

        const errorMessage = error.response?.data?.message || error.message || "Unknown Flutterwave API Error";

        logger.error(`[FlutterwaveClient] Request Failed: ${method.toUpperCase()} ${url} | Status: ${statusCode || "NETWORK_ERROR"} | Error: ${errorMessage}`);

        if ((isNetworkError || isTransientStatus) && attempt <= maxRetries) {
          const delayMs = Math.pow(2, attempt) * 500;
          logger.warn(`[FlutterwaveClient] Transient failure detected (${isNetworkError ? "Network Error" : `HTTP ${statusCode}`}). Retrying request: ${method.toUpperCase()} ${url}. Attempt ${attempt} of ${maxRetries}. Delaying for ${delayMs}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        throw new FlutterwaveError(
          `Flutterwave API Request Failed: ${errorMessage}`,
          statusCode,
          error.response?.data
        );
      }
    }
  }

  public verifyWebhookSignature(signatureHeader: string | null, payloadString: string): boolean {
    const secret = this.config.webhookSecret;

    if (!signatureHeader || !secret) {
      logger.warn("[Webhook] Verification failed: Missing signature header or loaded webhook secret.");
      return false;
    }

    try {
      const isVerified = signatureHeader === secret;
      logger.info(`[Webhook] Signature verification status: ${isVerified}`);
      return isVerified;
    } catch (error: any) {
      logger.error(`[FlutterwaveClient] Signature validation exception: ${error.message}`);
      return false;
    }
  }

  public async healthCheck(): Promise<boolean> {
    try {
      logger.info("[FlutterwaveClient] Executing payment provider healthCheck...");
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
