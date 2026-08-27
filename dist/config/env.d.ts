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
    GATEWAY_API_KEYS: string[];
    JWT_SECRET: string;
    CORS_ALLOWED_ORIGINS: string[];
    WHATSAPP_API_URL: string;
    WHATSAPP_API_KEY: string;
    WHATSAPP_INSTANCE_ID: string;
    WHATSAPP_ADMIN_USERNAME: string;
    WHATSAPP_ADMIN_PASSWORD: string;
    EMAIL_API_URL: string;
    EMAIL_API_KEY: string;
    EMAIL_INSTANCE_ID?: string;
    SQUAD_BASE_URL: string;
    SQUAD_SECRET_KEY: string;
    SQUAD_BENEFICIARY_ACCOUNT?: string;
}
export declare const env: EnvConfig;
