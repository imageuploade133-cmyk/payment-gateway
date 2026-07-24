import { Router } from "express";
import * as clubkonnectController from "../controllers/clubkonnect.controller";
import { gatewayAuthMiddleware } from "../middleware/auth";

const router = Router();

// Endpoint for checking Clubkonnect VTU balance (Protected S2S API Key or Bearer token verification)
router.get("/vtu/balance", gatewayAuthMiddleware, clubkonnectController.getWalletBalance);

export default router;
