import { Router } from "express";
import * as clubkonnectController from "../controllers/clubkonnect.controller";
import { gatewayAuthMiddleware } from "../middleware/auth";

const router = Router();

// Endpoint for checking Clubkonnect VTU balance (Protected S2S API Key or Bearer token verification)
router.get("/vtu/balance", gatewayAuthMiddleware, clubkonnectController.getWalletBalance);

// Public dynamic VTU metadata endpoints
router.get("/vtu/networks", clubkonnectController.getNetworks);
router.get("/vtu/data/plans", clubkonnectController.getDataPlans);

// VTU & Bill Endpoints protected via gatewayAuthMiddleware
router.post("/vtu/airtime", gatewayAuthMiddleware, clubkonnectController.purchaseAirtime);
router.post("/vtu/data", gatewayAuthMiddleware, clubkonnectController.purchaseData);
router.post("/vtu/cable", gatewayAuthMiddleware, clubkonnectController.purchaseCable);
router.post("/vtu/electricity", gatewayAuthMiddleware, clubkonnectController.purchaseElectricity);
router.post("/vtu/waec", gatewayAuthMiddleware, clubkonnectController.purchaseWaec);

// Public webhook callback endpoint for Clubkonnect notifications
router.post("/vtu/clubkonnect/callback", clubkonnectController.handleCallback);
router.get("/vtu/clubkonnect/callback", clubkonnectController.handleCallback);

export default router;
