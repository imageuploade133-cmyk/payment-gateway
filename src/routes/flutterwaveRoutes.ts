import { Router } from "express";
import * as flwController from "../controllers/flutterwaveController";
import { accountResolutionRateLimiter, transferRateLimiter } from "../middleware/rateLimiter";
import { gatewayAuthMiddleware } from "../middleware/auth";

const router = Router();

// Protected S2S endpoints (require S2S API Key verification)
router.post("/resolve-account", gatewayAuthMiddleware, accountResolutionRateLimiter, flwController.resolveAccount);
router.post("/transfer", gatewayAuthMiddleware, transferRateLimiter, flwController.initiateTransfer);
router.post("/bulk-transfer", gatewayAuthMiddleware, flwController.initiateBulkTransfer);
router.post("/create-virtual-account", gatewayAuthMiddleware, flwController.createVirtualAccount);
router.post("/verify", gatewayAuthMiddleware, flwController.verifyPayment);

// Public Webhook endpoint (secured via provider cryptographic signature hash validation)
router.post("/webhook", flwController.handleWebhook);

export default router;
