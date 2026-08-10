import { Router } from "express";
import { AdminController } from "../controllers/adminController";
import { gatewayAuthMiddleware } from "../middleware/auth";
import { adminAuthMiddleware, strictHumanAdminAuthMiddleware } from "../middleware/adminAuth";

const router = Router();

// Secure admin-only endpoints: requires gatewayAuthMiddleware to authenticate token/key, then adminAuthMiddleware to assert privilege
router.post("/metrics", gatewayAuthMiddleware, adminAuthMiddleware, AdminController.getMetrics);
router.post("/reconciliation", gatewayAuthMiddleware, adminAuthMiddleware, AdminController.runReconciliation);
router.post("/sync-banks", gatewayAuthMiddleware, adminAuthMiddleware, AdminController.syncBanks);

// Secure human-only KYC administrative endpoints (strictly require verified Firebase Admin ID Token, X-API-Key is denied)
router.get("/kyc/pending", gatewayAuthMiddleware, strictHumanAdminAuthMiddleware, AdminController.getPendingKycSubmissions);
router.post("/kyc/:userId/approve", gatewayAuthMiddleware, strictHumanAdminAuthMiddleware, AdminController.approveKycSubmission);
router.post("/kyc/:userId/reject", gatewayAuthMiddleware, strictHumanAdminAuthMiddleware, AdminController.rejectKycSubmission);
router.post("/kyc/:userId/retry-provisioning", gatewayAuthMiddleware, strictHumanAdminAuthMiddleware, AdminController.retryKycProvisioning);

export default router;
