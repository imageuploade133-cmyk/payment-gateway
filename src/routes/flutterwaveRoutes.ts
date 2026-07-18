import { Router } from "express";
import * as flwController from "../controllers/flutterwaveController";
import { accountResolutionRateLimiter, transferRateLimiter } from "../middleware/rateLimiter";

const router = Router();

router.post("/resolve-account", accountResolutionRateLimiter, flwController.resolveAccount);
router.post("/transfer", transferRateLimiter, flwController.initiateTransfer);
router.post("/bulk-transfer", flwController.initiateBulkTransfer);
router.post("/create-virtual-account", flwController.createVirtualAccount);
router.post("/verify", flwController.verifyPayment);
router.post("/webhook", flwController.handleWebhook);

export default router;
