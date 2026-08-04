import { Router } from "express";
import { AdminController } from "../controllers/adminController";
import { gatewayAuthMiddleware } from "../middleware/auth";
import { adminAuthMiddleware } from "../middleware/adminAuth";

const router = Router();

// Secure admin-only endpoints: requires gatewayAuthMiddleware to authenticate token/key, then adminAuthMiddleware to assert privilege
router.post("/metrics", gatewayAuthMiddleware, adminAuthMiddleware, AdminController.getMetrics);
router.post("/reconciliation", gatewayAuthMiddleware, adminAuthMiddleware, AdminController.runReconciliation);
router.post("/sync-banks", gatewayAuthMiddleware, adminAuthMiddleware, AdminController.syncBanks);

export default router;
