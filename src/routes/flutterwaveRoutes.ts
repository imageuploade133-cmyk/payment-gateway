import { Router } from "express";
import * as flwController from "../controllers/flutterwaveController";
import { accountResolutionRateLimiter, transferRateLimiter } from "../middleware/rateLimiter";
import { gatewayAuthMiddleware } from "../middleware/auth";

const router = Router();

// Protected S2S endpoints (require S2S API Key verification)
router.post("/proxy", gatewayAuthMiddleware, flwController.proxy);
router.get("/banks", gatewayAuthMiddleware, flwController.getBanks);
router.post("/banks/refresh", gatewayAuthMiddleware, flwController.refreshBanksList);
router.get("/rates", gatewayAuthMiddleware, flwController.getExchangeRates);
router.get("/transfer-fee", gatewayAuthMiddleware, flwController.getTransferFee);
router.post("/initialize", gatewayAuthMiddleware, flwController.initializePayment);
router.post("/resolve-account", gatewayAuthMiddleware, accountResolutionRateLimiter, flwController.resolveAccount);
router.post("/transfer", gatewayAuthMiddleware, transferRateLimiter, flwController.initiateTransfer);
router.post("/bulk-transfer", gatewayAuthMiddleware, flwController.initiateBulkTransfer);
router.post("/charges", gatewayAuthMiddleware, flwController.charge);
router.post("/bills", gatewayAuthMiddleware, flwController.payBill);
router.get("/kyc-status", gatewayAuthMiddleware, flwController.getKycStatus);
router.post("/kyc-status", gatewayAuthMiddleware, flwController.getKycStatus);
router.post("/create-virtual-account", gatewayAuthMiddleware, flwController.createVirtualAccount);
router.post("/verify-transfer", gatewayAuthMiddleware, flwController.verifyTransfer);
router.get("/transfer/status/:reference", gatewayAuthMiddleware, flwController.getTransferStatus);
router.post("/reconcile/:reference", gatewayAuthMiddleware, flwController.reconcileTransfer);
router.post("/verify", gatewayAuthMiddleware, flwController.verifyPayment);

// Protected Virtual Cards S2S Endpoints
router.post("/cards", gatewayAuthMiddleware, flwController.createVirtualCard);
router.get("/cards/:id", gatewayAuthMiddleware, flwController.getVirtualCard);
router.post("/cards/:id/fund", gatewayAuthMiddleware, flwController.fundVirtualCard);
router.post("/cards/:id/withdraw", gatewayAuthMiddleware, flwController.withdrawVirtualCard);
router.put("/cards/:id/status", gatewayAuthMiddleware, flwController.updateCardStatus);
router.put("/cards/:id/terminate", gatewayAuthMiddleware, flwController.terminateVirtualCard);
router.get("/cards/:id/transactions", gatewayAuthMiddleware, flwController.getCardTransactions);

// Public Webhook endpoint (secured via provider cryptographic signature hash validation)
router.post("/webhook", flwController.handleWebhook);

export default router;
