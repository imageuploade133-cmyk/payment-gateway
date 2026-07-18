import dotenv from "dotenv";
import logger from "./logger";

dotenv.config();

export interface EnvConfig {
  PORT: number;
  NODE_ENV: string;
  FLW_BASE_URL: string;
  FLW_SECRET_KEY?: string;
  FLW_PUBLIC_KEY?: string;
  FLW_WEBHOOK_SECRET?: string;
  PAYSTACK_BASE_URL: string;
  PAYSTACK_SECRET_KEY?: string;
  PAYSTACK_PUBLIC_KEY?: string;
  PAYSTACK_WEBHOOK_SECRET?: string;
  GATEWAY_API_KEY?: string;
  JWT_SECRET?: string;
}

function validateEnv(): EnvConfig {
  const PORT = Number(process.env.PORT) || 3055;
  const NODE_ENV = process.env.NODE_ENV || "development";
  const FLW_BASE_URL = process.env.FLW_BASE_URL || "https://api.flutterwave.com/v3";
  const PAYSTACK_BASE_URL = process.env.PAYSTACK_BASE_URL || "https://api.paystack.co";

  const config: EnvConfig = {
    PORT,
    NODE_ENV,
    FLW_BASE_URL,
    FLW_SECRET_KEY: process.env.FLW_SECRET_KEY,
    FLW_PUBLIC_KEY: process.env.FLW_PUBLIC_KEY,
    FLW_WEBHOOK_SECRET: process.env.FLW_WEBHOOK_SECRET,
    PAYSTACK_BASE_URL,
    PAYSTACK_SECRET_KEY: process.env.PAYSTACK_SECRET_KEY,
    PAYSTACK_PUBLIC_KEY: process.env.PAYSTACK_PUBLIC_KEY,
    PAYSTACK_WEBHOOK_SECRET: process.env.PAYSTACK_WEBHOOK_SECRET,
    GATEWAY_API_KEY: process.env.GATEWAY_API_KEY,
    JWT_SECRET: process.env.JWT_SECRET,
  };

  // Log active state
  logger.info(`[Config] Environment successfully loaded. Mode: ${NODE_ENV}, Port: ${PORT}`);

  return config;
}

export const env = validateEnv();
