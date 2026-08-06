import { Router } from "express";
import { registerToken, unregisterToken } from "../controllers/fcmController";
import { gatewayAuthMiddleware } from "../middleware/auth";

const router = Router();

router.post("/register", gatewayAuthMiddleware, registerToken);
router.delete("/unregister", gatewayAuthMiddleware, unregisterToken);
router.delete("/register", gatewayAuthMiddleware, unregisterToken); // For backward compatibility/unification

export default router;
