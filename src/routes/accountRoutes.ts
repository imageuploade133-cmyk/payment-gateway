import { Router } from "express";
import { resolveAccount, discoverAccount } from "../controllers/accountController";
import { gatewayAuthMiddleware } from "../middleware/auth";
import { accountResolutionRateLimiter } from "../middleware/rateLimiter";

const router = Router();

// Secure top-level endpoint (protected via S2S API Key and rate-limiting)
router.post("/resolve", gatewayAuthMiddleware, accountResolutionRateLimiter, resolveAccount);
router.post("/discover", gatewayAuthMiddleware, accountResolutionRateLimiter, discoverAccount);

export default router;
