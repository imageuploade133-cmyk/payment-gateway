import { Router } from "express";
import { getHealth, getReady, getLive } from "../controllers/systemController";
import flutterwaveRoutes from "./flutterwaveRoutes";
import paystackRoutes from "./paystackRoutes";

const router = Router();

// Public System Monitoring & Diagnostics
router.get("/health", getHealth);
router.get("/ready", getReady);
router.get("/live", getLive);

// Provider API routes
router.use("/api/flutterwave", flutterwaveRoutes);
router.use("/api/paystack", paystackRoutes);

export default router;
