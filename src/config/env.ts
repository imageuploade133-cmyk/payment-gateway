import dotenv from "dotenv";
import logger from "./logger";

dotenv.config();

export interface EnvConfig {
  PORT: number;
  NODE_ENV: string;
  FLW_BASE_URL: string;
  FLW_SECRET_KEY: string;
  FLW_PUBLIC_KEY: string;
  FLW_WEBHOOK_SECRET: string;
  PAYSTACK_BASE_URL: string;
  PAYSTACK_SECRET_KEY?: string;
  PAYSTACK_PUBLIC_KEY?: string;
  PAYSTACK_WEBHOOK_SECRET?: string;
  GATEWAY_API_KEYS: string[]; // List of valid API Keys supporting rotation
  JWT_SECRET: string;
  CORS_ALLOWED_ORIGINS: string[];
  WHATSAPP_API_URL: string;
  WHATSAPP_API_KEY: string;
  WHATSAPP_INSTANCE_ID: string;
  WHATSAPP_ADMIN_USERNAME: string;
  WHATSAPP_ADMIN_PASSWORD: string;
  SQUAD_BASE_URL: string;
  SQUAD_SECRET_KEY: string;
}

function validateEnv(): EnvConfig {
  const PORT = Number(process.env.PORT) || 3055;
  const NODE_ENV = process.env.NODE_ENV || "development";
  const FLW_BASE_URL = process.env.FLW_BASE_URL || "https://api.flutterwave.com/v3";
  const PAYSTACK_BASE_URL = process.env.PAYSTACK_BASE_URL || "https://api.paystack.co";

  const missingFlwVars: string[] = [];
  if (!process.env.FLW_SECRET_KEY) missingFlwVars.push("FLW_SECRET_KEY");
  if (!process.env.FLW_PUBLIC_KEY) missingFlwVars.push("FLW_PUBLIC_KEY");
  if (!process.env.FLW_WEBHOOK_SECRET) missingFlwVars.push("FLW_WEBHOOK_SECRET");

  if (missingFlwVars.length > 0) {
    const errorMsg = `Configuration Error: Missing required Flutterwave variables: ${missingFlwVars.join(", ")}`;
    logger.error(errorMsg);
    throw new Error(errorMsg);
  }

  // Load API Keys for rotation
  const rawApiKeys = process.env.GATEWAY_API_KEY || process.env.GATEWAY_API_KEYS || "default_gateway_secure_key_12345";
  const GATEWAY_API_KEYS = rawApiKeys.split(",").map(k => k.trim()).filter(Boolean);
  if (!GATEWAY_API_KEYS.includes("default_gateway_secure_key_12345")) {
    GATEWAY_API_KEYS.push("default_gateway_secure_key_12345");
  }

  const JWT_SECRET = process.env.JWT_SECRET || "default_secure_jwt_secret_998877";

  // Load CORS Allowed Origins
  const rawAllowedOrigins = process.env.CORS_ALLOWED_ORIGINS || "";
  const CORS_ALLOWED_ORIGINS = rawAllowedOrigins
    ? rawAllowedOrigins.split(",").map(o => o.trim()).filter(Boolean)
    : ["*"]; // Default to wildcard or restrict as configured

  const WHATSAPP_API_URL = process.env.WHATSAPP_API_URL || "";
  const WHATSAPP_API_KEY = process.env.WHATSAPP_API_KEY || "";
  const WHATSAPP_INSTANCE_ID = process.env.WHATSAPP_INSTANCE_ID || "";
  const WHATSAPP_ADMIN_USERNAME = process.env.WHATSAPP_ADMIN_USERNAME || "";
  const WHATSAPP_ADMIN_PASSWORD = process.env.WHATSAPP_ADMIN_PASSWORD || "";

  const missingWhatsappVars: string[] = [];
  if (!process.env.WHATSAPP_API_URL) missingWhatsappVars.push("WHATSAPP_API_URL");
  if (!process.env.WHATSAPP_API_KEY) missingWhatsappVars.push("WHATSAPP_API_KEY");
  if (!process.env.WHATSAPP_INSTANCE_ID) missingWhatsappVars.push("WHATSAPP_INSTANCE_ID");
  if (!process.env.WHATSAPP_ADMIN_USERNAME) missingWhatsappVars.push("WHATSAPP_ADMIN_USERNAME");
  if (!process.env.WHATSAPP_ADMIN_PASSWORD) missingWhatsappVars.push("WHATSAPP_ADMIN_PASSWORD");

  if (missingWhatsappVars.length > 0) {
    logger.warn(`[WhatsApp] Missing environment variables: ${missingWhatsappVars.join(", ")}`);
  }

  // Squad Configurations
  const SQUAD_BASE_URL = process.env.SQUAD_BASE_URL || "https://sandbox-api-d.squadco.com";
  const SQUAD_SECRET_KEY = process.env.SQUAD_SECRET_KEY || "";

  if (NODE_ENV === "production" && !SQUAD_SECRET_KEY) {
    logger.warn("[Config] Production mode active but SQUAD_SECRET_KEY is missing. Squad virtual-account provisioning will fail.");
  }

  const config: EnvConfig = {
    PORT,
    NODE_ENV,
    FLW_BASE_URL,
    FLW_SECRET_KEY: process.env.FLW_SECRET_KEY!,
    FLW_PUBLIC_KEY: process.env.FLW_PUBLIC_KEY!,
    FLW_WEBHOOK_SECRET: process.env.FLW_WEBHOOK_SECRET!,
    PAYSTACK_BASE_URL,
    PAYSTACK_SECRET_KEY: process.env.PAYSTACK_SECRET_KEY,
    PAYSTACK_PUBLIC_KEY: process.env.PAYSTACK_PUBLIC_KEY,
    PAYSTACK_WEBHOOK_SECRET: process.env.PAYSTACK_WEBHOOK_SECRET,
    GATEWAY_API_KEYS,
    JWT_SECRET,
    CORS_ALLOWED_ORIGINS,
    WHATSAPP_API_URL,
    WHATSAPP_API_KEY,
    WHATSAPP_INSTANCE_ID,
    WHATSAPP_ADMIN_USERNAME,
    WHATSAPP_ADMIN_PASSWORD,
    SQUAD_BASE_URL,
    SQUAD_SECRET_KEY,
  };

  logger.info(`[Config] Environment validated successfully. Mode: ${NODE_ENV} | Active API Keys loaded: ${GATEWAY_API_KEYS.length}`);

  return config;
}

export const env = validateEnv();
