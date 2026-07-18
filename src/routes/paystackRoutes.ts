import { Router } from "express";
import * as paystackController from "../controllers/paystackController";

const router = Router();

router.post("/initialize", paystackController.initializePayment);
router.post("/verify", paystackController.verifyPayment);
router.post("/webhook", paystackController.handleWebhook);

export default router;
