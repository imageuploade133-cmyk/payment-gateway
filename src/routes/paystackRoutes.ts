import { Router } from "express";
import * as paystackController from "../controllers/paystackController";
import { gatewayAuthMiddleware } from "../middleware/auth";
import { accountResolutionRateLimiter, transferRateLimiter } from "../middleware/rateLimiter";

const router = Router();

// Protected S2S endpoints (require S2S API Key verification)
router.post("/initialize", gatewayAuthMiddleware, paystackController.initializePayment);
router.post("/resolve-account", gatewayAuthMiddleware, accountResolutionRateLimiter, paystackController.resolveAccount);
router.post("/transfer", gatewayAuthMiddleware, transferRateLimiter, paystackController.initiateTransfer);
router.post("/verify", gatewayAuthMiddleware, paystackController.verifyPayment);

// Public Webhook endpoint (secured via Paystack cryptographic signature hash validation)
router.post("/webhook", paystackController.handleWebhook);

export default router;
