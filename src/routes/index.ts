import { Router } from "express";
import { getHealth } from "../controllers/systemController";
import flutterwaveRoutes from "./flutterwaveRoutes";
import paystackRoutes from "./paystackRoutes";

const router = Router();

// System Health
router.get("/health", getHealth);

// Provider API routes
router.use("/api/flutterwave", flutterwaveRoutes);
router.use("/api/paystack", paystackRoutes);

export default router;
