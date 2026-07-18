import { FlutterwaveClient } from "./FlutterwaveClient";
import { env } from "../../config/env";

export * from "./FlutterwaveClient";
export * from "./FlutterwaveConfig";
export * from "./FlutterwaveError";

// Lazy-loaded or validated singleton instance
let flutterwaveClientInstance: FlutterwaveClient | null = null;

export function getFlutterwaveClient(): FlutterwaveClient {
  if (!flutterwaveClientInstance) {
    flutterwaveClientInstance = new FlutterwaveClient({
      baseUrl: env.FLW_BASE_URL,
      publicKey: env.FLW_PUBLIC_KEY,
      secretKey: env.FLW_SECRET_KEY,
      webhookSecret: env.FLW_WEBHOOK_SECRET,
    });
  }
  return flutterwaveClientInstance;
}
