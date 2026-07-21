import { Router } from "express";
import { resolveAccount } from "../controllers/accountController";
import { gatewayAuthMiddleware } from "../middleware/auth";
import { accountResolutionRateLimiter } from "../middleware/rateLimiter";

const router = Router();

// Secure top-level endpoint (protected via S2S API Key and rate-limiting)
router.post("/resolve", gatewayAuthMiddleware, accountResolutionRateLimiter, resolveAccount);

export default router;
