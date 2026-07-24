import axios, { AxiosInstance, AxiosResponse, InternalAxiosRequestConfig } from "axios";
import crypto from "crypto";
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

  private setupInterceptors(): void {
    this.client.interceptors.request.use(
      (reqConfig: InternalAxiosRequestConfig) => {
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

    this.client.interceptors.response.use(
      (response: AxiosResponse) => {
        logger.debug(
          `[FlutterwaveClient] Response Success: ${response.config.method?.toUpperCase()} ${response.config.url} | Status: ${response.status}`
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
            `[FlutterwaveClient] Transient failure detected (${error.message || "Network Error"}). Retrying request: ${reqConfig.method?.toUpperCase()} ${reqConfig.url}. Attempt ${reqConfig.metadata.retryCount} of ${this.config.maxRetries}. Delaying for ${backoffDelay}ms...`
          );

          await new Promise((resolve) => setTimeout(resolve, backoffDelay));
          return this.client(reqConfig);
        }

        const flwError = FlutterwaveError.fromError(error);
        logger.error(
          `[FlutterwaveClient] Request Failed: ${reqConfig?.method?.toUpperCase()} ${reqConfig?.url} | Status: ${flwError.statusCode} | Error: ${flwError.message}`
        );
        return Promise.reject(flwError);
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
   * Verifies the authenticity of an incoming Flutterwave webhook signature header.
   */
  public verifyWebhookSignature(signatureHeader: string | null, payloadString: string): boolean {
    const secret = this.config.webhookSecret;

    logger.info("[Webhook] Signature verification initiated.");
    logger.info(`[Webhook] Signature header exists: ${!!signatureHeader}`);
    logger.info(`[Webhook] Signature length: ${signatureHeader?.length ?? 0}`);
    logger.info(`[Webhook] Secret loaded: ${!!secret}`);
    logger.info(`[Webhook] Secret length: ${secret?.length ?? 0}`);
    logger.info("[Webhook] Verification method being used: Direct Secret Hash Comparison");

    if (!signatureHeader || !secret) {
      logger.warn("[Webhook] Verification failed: Missing signature header or loaded webhook secret.");
      return false;
    }

    try {
      // Direct string comparison as specified by Flutterwave Webhook Secret Hash documentation
      const isVerified = signatureHeader === secret;
      logger.info(`[Webhook] Signature verification success: ${isVerified}`);
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
