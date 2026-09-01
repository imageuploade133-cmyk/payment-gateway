"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.env = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
const logger_1 = __importDefault(require("./logger"));
dotenv_1.default.config();
function validateEnv() {
    const PORT = Number(process.env.PORT) || 3055;
    const NODE_ENV = process.env.NODE_ENV || "development";
    const FLW_BASE_URL = process.env.FLW_BASE_URL || "https://api.flutterwave.com/v3";
    const PAYSTACK_BASE_URL = process.env.PAYSTACK_BASE_URL || "https://api.paystack.co";
    const missingFlwVars = [];
    if (!process.env.FLW_SECRET_KEY)
        missingFlwVars.push("FLW_SECRET_KEY");
    if (!process.env.FLW_PUBLIC_KEY)
        missingFlwVars.push("FLW_PUBLIC_KEY");
    if (!process.env.FLW_WEBHOOK_SECRET)
        missingFlwVars.push("FLW_WEBHOOK_SECRET");
    if (missingFlwVars.length > 0) {
        const errorMsg = `Configuration Error: Missing required Flutterwave variables: ${missingFlwVars.join(", ")}`;
        logger_1.default.error(errorMsg);
        throw new Error(errorMsg);
    }
    // Load API Keys for rotation
    const rawApiKeys = process.env.GATEWAY_API_KEY || process.env.GATEWAY_API_KEYS;
    if (NODE_ENV === "production" && !rawApiKeys) {
        const errorMsg = "Configuration Error: Missing required GATEWAY_API_KEY in production mode.";
        logger_1.default.error(errorMsg);
        throw new Error(errorMsg);
    }
    const GATEWAY_API_KEYS = (rawApiKeys || "default_gateway_secure_key_12345")
        .split(",")
        .map(k => k.trim())
        .filter(Boolean);
    let JWT_SECRET = process.env.JWT_SECRET;
    if (NODE_ENV === "production" && !JWT_SECRET) {
        const errorMsg = "Configuration Error: Missing required JWT_SECRET in production mode.";
        logger_1.default.error(errorMsg);
        throw new Error(errorMsg);
    }
    if (!JWT_SECRET) {
        JWT_SECRET = "default_secure_jwt_secret_998877";
    }
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
    const missingWhatsappVars = [];
    if (!process.env.WHATSAPP_API_URL)
        missingWhatsappVars.push("WHATSAPP_API_URL");
    if (!process.env.WHATSAPP_API_KEY)
        missingWhatsappVars.push("WHATSAPP_API_KEY");
    if (!process.env.WHATSAPP_INSTANCE_ID)
        missingWhatsappVars.push("WHATSAPP_INSTANCE_ID");
    if (!process.env.WHATSAPP_ADMIN_USERNAME)
        missingWhatsappVars.push("WHATSAPP_ADMIN_USERNAME");
    if (!process.env.WHATSAPP_ADMIN_PASSWORD)
        missingWhatsappVars.push("WHATSAPP_ADMIN_PASSWORD");
    if (missingWhatsappVars.length > 0) {
        logger_1.default.warn(`[WhatsApp] Missing environment variables: ${missingWhatsappVars.join(", ")}`);
    }
    const EMAIL_API_URL = process.env.EMAIL_API_URL || "";
    const EMAIL_API_KEY = process.env.EMAIL_API_KEY || "";
    const EMAIL_INSTANCE_ID = process.env.EMAIL_INSTANCE_ID || process.env.EMAIL_PROJECT_ID || "";
    if (!process.env.EMAIL_API_URL || !process.env.EMAIL_API_KEY) {
        logger_1.default.warn("[Email] Missing environment variables: EMAIL_API_URL or EMAIL_API_KEY");
    }
    // Squad Configurations
    const SQUAD_BASE_URL = process.env.SQUAD_BASE_URL || "https://sandbox-api-d.squadco.com";
    const SQUAD_SECRET_KEY = process.env.SQUAD_SECRET_KEY || "";
    const SQUAD_BENEFICIARY_ACCOUNT = process.env.SQUAD_BENEFICIARY_ACCOUNT || "";
    if (NODE_ENV === "production" && !SQUAD_SECRET_KEY) {
        logger_1.default.warn("[Config] Production mode active but SQUAD_SECRET_KEY is missing. Squad virtual-account provisioning will fail.");
    }
    const config = {
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
        GATEWAY_API_KEYS,
        JWT_SECRET,
        CORS_ALLOWED_ORIGINS,
        WHATSAPP_API_URL,
        WHATSAPP_API_KEY,
        WHATSAPP_INSTANCE_ID,
        WHATSAPP_ADMIN_USERNAME,
        WHATSAPP_ADMIN_PASSWORD,
        EMAIL_API_URL,
        EMAIL_API_KEY,
        EMAIL_INSTANCE_ID,
        SQUAD_BASE_URL,
        SQUAD_SECRET_KEY,
        SQUAD_BENEFICIARY_ACCOUNT,
    };
    logger_1.default.info(`[Config] Environment validated successfully. Mode: ${NODE_ENV} | Active API Keys loaded: ${GATEWAY_API_KEYS.length}`);
    return config;
}
exports.env = validateEnv();
//# sourceMappingURL=env.js.map