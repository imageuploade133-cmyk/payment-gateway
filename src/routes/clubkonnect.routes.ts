import { Router } from "express";
import * as clubkonnectController from "../controllers/clubkonnect.controller";
import { gatewayAuthMiddleware } from "../middleware/auth";

const router = Router();

// Endpoint for checking Clubkonnect VTU balance (Protected S2S API Key or Bearer token verification)
router.get("/vtu/balance", gatewayAuthMiddleware, clubkonnectController.getWalletBalance);

// Endpoint for purchasing Clubkonnect Airtime (Protected S2S API Key or Bearer token verification)
router.post("/vtu/airtime", gatewayAuthMiddleware, clubkonnectController.purchaseAirtime);

// Public webhook callback endpoint for Clubkonnect notifications
router.post("/vtu/clubkonnect/callback", clubkonnectController.handleCallback);

// Support GET for testing callback or fallback structures
router.get("/vtu/clubkonnect/callback", clubkonnectController.handleCallback);

export default router;
