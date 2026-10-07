import { Router } from "express";
import { AdminController } from "../controllers/adminController";
import { gatewayAuthMiddleware } from "../middleware/auth";
import {
  adminAuthMiddleware,
  strictHumanAdminAuthMiddleware,
  requireFirebaseAuth,
  requireAdmin,
  requirePermission,
} from "../middleware/adminAuth";

const router = Router();

// Secure admin metrics, reconciliation, and bank sync (supports S2S API key or Firebase Auth token)
router.post("/metrics", gatewayAuthMiddleware, adminAuthMiddleware, AdminController.getMetrics);
router.post("/reconciliation", gatewayAuthMiddleware, adminAuthMiddleware, AdminController.runReconciliation);
router.post("/sync-banks", gatewayAuthMiddleware, adminAuthMiddleware, AdminController.syncBanks);

router.get("/virtual-accounts/search", requireFirebaseAuth, requireAdmin, requirePermission("virtual_accounts.view"), AdminController.searchVirtualAccounts);
router.get("/virtual-accounts/:userId", requireFirebaseAuth, requireAdmin, requirePermission("virtual_accounts.view"), AdminController.getVirtualAccountAdminDetails);
router.post("/virtual-accounts/:userId/replace", requireFirebaseAuth, requireAdmin, requirePermission("virtual_accounts.manage"), AdminController.replaceVirtualAccount);

// Secure human-only KYC administrative endpoints
router.get("/kyc/pending", requireFirebaseAuth, requireAdmin, requirePermission("kyc.view"), AdminController.getPendingKycSubmissions);
router.post("/kyc/:userId/approve", requireFirebaseAuth, requireAdmin, requirePermission("kyc.approve"), AdminController.approveKycSubmission);
router.post("/kyc/:userId/reject", requireFirebaseAuth, requireAdmin, requirePermission("kyc.reject"), AdminController.rejectKycSubmission);
router.post("/kyc/:userId/retry-provisioning", requireFirebaseAuth, requireAdmin, requirePermission("kyc.approve"), AdminController.retryKycProvisioning);
router.delete("/kyc/:userId", requireFirebaseAuth, requireAdmin, requirePermission("kyc.reject"), AdminController.deleteUnverifiedUser);

// Secure Admin Management endpoints (strictly requires Firebase Auth + requireAdmin + requirePermission("admins.view" / "admins.edit"))
router.get("/admins", requireFirebaseAuth, requireAdmin, requirePermission("admins.view"), AdminController.getAdmins);
router.post("/admins", requireFirebaseAuth, requireAdmin, requirePermission("admins.edit"), AdminController.manageAdmin);

export default router;
