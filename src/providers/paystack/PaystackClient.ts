import axios, { AxiosInstance, AxiosResponse, InternalAxiosRequestConfig } from "axios";
import crypto from "crypto";
import { PaymentProvider } from "../PaymentProvider";
import { PaystackConfig } from "./PaystackConfig";
import { PaystackError } from "./PaystackError";
import logger from "../../config/logger";

export class PaystackClient implements PaymentProvider {
  public readonly name = "paystack";
  private readonly client: AxiosInstance;
  private readonly config: PaystackConfig;

  constructor(config: PaystackConfig) {
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

  private setupInterceptors(): void {
    // 1. Request Interceptor
    this.client.interceptors.request.use(
      (reqConfig: InternalAxiosRequestConfig) => {
        reqConfig.headers.Authorization = `Bearer ${this.config.secretKey}`;
        logger.debug(
          `[PaystackClient] Outgoing Request: ${reqConfig.method?.toUpperCase()} ${reqConfig.url}`
        );
        return reqConfig;
      },
      (error: any) => {
        logger.error(`[PaystackClient] Request Setup Error: ${error.message}`);
        return Promise.reject(error);
      }
    );

    // 2. Response Interceptor
    this.client.interceptors.response.use(
      (response: AxiosResponse) => {
        logger.debug(
          `[PaystackClient] Response Success: ${response.config.method?.toUpperCase()} ${response.config.url} | Status: ${response.status}`
        );
        return response;
      },
      async (error: any) => {
        const reqConfig = error.config;
        const isTransient = this.isTransientFailure(error);
        const retryCount = reqConfig ? (reqConfig.metadata?.retryCount || 0) : 0;

        if (isTransient && reqConfig && retryCount < (this.config.maxRetries || 3)) {
          reqConfig.metadata = reqConfig.metadata || {};
          reqConfig.metadata.retryCount = retryCount + 1;

          const backoffDelay = Math.pow(2, retryCount) * 1000;
          logger.warn(
            `[PaystackClient] Transient failure detected (${error.message || "Network Error"}). Retrying request: ${reqConfig.method?.toUpperCase()} ${reqConfig.url}. Attempt ${reqConfig.metadata.retryCount} of ${this.config.maxRetries}. Delaying for ${backoffDelay}ms...`
          );

          await new Promise((resolve) => setTimeout(resolve, backoffDelay));
          return this.client(reqConfig);
        }

        const pstkError = PaystackError.fromError(error);
        logger.error(
          `[PaystackClient] Request Failed: ${reqConfig?.method?.toUpperCase()} ${reqConfig?.url} | Status: ${pstkError.statusCode} | Error: ${pstkError.message}`
        );
        return Promise.reject(pstkError);
      }
    );
  }

  private isTransientFailure(error: any): boolean {
    if (!error.response) {
      return true;
    }
    const status = error.response.status;
    return status === 429 || status === 502 || status === 503 || status === 504;
  }

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
      throw error;
    }
  }

  /**
   * Verifies the authenticity of an incoming Paystack webhook signature header.
   * Paystack uses HMAC-SHA512 of the raw body payload.
   */
  public verifyWebhookSignature(signatureHeader: string | null, payloadString: string): boolean {
    const secret = this.config.webhookSecret;
    if (!signatureHeader || !secret) {
      return false;
    }

    try {
      const hash = crypto.createHmac("sha512", secret).update(payloadString).digest("hex");
      return signatureHeader === hash;
    } catch (error: any) {
      logger.error(`[PaystackClient] Signature validation exception: ${error.message}`);
      return false;
    }
  }

  public async healthCheck(): Promise<boolean> {
    try {
      logger.info("[PaystackClient] Executing payment provider healthCheck...");
      // Check Paystack banks list as credential verification query
      const response = await this.request("get", "/bank");
      const success = response && response.status === true;
      logger.info(`[PaystackClient] healthCheck results: ${success ? "SUCCESS" : "FAILED"}`);
      return success;
    } catch (error: any) {
      logger.error(`[PaystackClient] healthCheck crashed: ${error.message}`);
      return false;
    }
  }
}
export default PaystackClient;
