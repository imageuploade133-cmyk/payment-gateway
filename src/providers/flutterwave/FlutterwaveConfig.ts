export interface FlutterwaveConfig {
  baseUrl: string;
  publicKey: string;
  secretKey: string;
  webhookSecret: string;
  timeoutMs?: number;
  maxRetries?: number;
}
