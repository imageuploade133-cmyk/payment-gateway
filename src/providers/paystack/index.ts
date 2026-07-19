import { PaystackClient } from "./PaystackClient";
import { env } from "../../config/env";

export * from "./PaystackClient";
export * from "./PaystackConfig";
export * from "./PaystackError";

let paystackClientInstance: PaystackClient | null = null;

export function getPaystackClient(): PaystackClient {
  if (!paystackClientInstance) {
    paystackClientInstance = new PaystackClient({
      baseUrl: env.PAYSTACK_BASE_URL,
      publicKey: env.PAYSTACK_PUBLIC_KEY || "pk_test_mock",
      secretKey: env.PAYSTACK_SECRET_KEY || "sk_test_mock",
      webhookSecret: env.PAYSTACK_WEBHOOK_SECRET || "paystack_wh_secret",
    });
  }
  return paystackClientInstance;
}
export default getPaystackClient;
