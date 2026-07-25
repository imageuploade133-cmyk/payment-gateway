import { Router } from "express";
import * as clubkonnectController from "../controllers/clubkonnect.controller";
import { gatewayAuthMiddleware } from "../middleware/auth";

const router = Router();

// Endpoint for checking Clubkonnect VTU balance (Protected S2S API Key or Bearer token verification)
router.get("/vtu/balance", gatewayAuthMiddleware, clubkonnectController.getWalletBalance);

// Public dynamic VTU metadata endpoints (Can also be checked with API Keys if requested, but let's allow easy discovery for the frontend)
router.get("/vtu/networks", clubkonnectController.getNetworks);
router.get("/vtu/data/plans", clubkonnectController.getDataPlans);

// Endpoint for purchasing Clubkonnect Airtime (Protected S2S API Key or Bearer token verification)
router.post("/vtu/airtime", gatewayAuthMiddleware, clubkonnectController.purchaseAirtime);

// Endpoint for purchasing Clubkonnect Mobile Data packages (Protected S2S API Key or Bearer token verification)
router.post("/vtu/data", gatewayAuthMiddleware, clubkonnectController.purchaseData);

// Public webhook callback endpoint for Clubkonnect notifications (idempotent single-run webhook handler)
router.post("/vtu/clubkonnect/callback", clubkonnectController.handleCallback);

// Support GET for testing callback or fallback structures
router.get("/vtu/clubkonnect/callback", clubkonnectController.handleCallback);

export default router;
