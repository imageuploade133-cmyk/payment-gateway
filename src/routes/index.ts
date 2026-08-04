import { Router } from "express";
import { getHealth, getReady, getLive } from "../controllers/systemController";
import flutterwaveRoutes from "./flutterwaveRoutes";
import paystackRoutes from "./paystackRoutes";
import accountRoutes from "./accountRoutes";
import clubkonnectRoutes from "./clubkonnect.routes";
import authRoutes from "./authRoutes";
import profileRoutes from "./profileRoutes";
import adminRoutes from "./adminRoutes";

const router = Router();

// Public System Monitoring & Diagnostics
router.get("/health", getHealth);
router.get("/ready", getReady);
router.get("/live", getLive);

// Provider API routes
router.use("/api/flutterwave", flutterwaveRoutes);
router.use("/api/paystack", paystackRoutes);
router.use("/api/accounts", accountRoutes);
router.use("/api/auth", authRoutes);
router.use("/api/profile", profileRoutes);
router.use("/api/admin", adminRoutes);
router.use("/api", clubkonnectRoutes);

export default router;
