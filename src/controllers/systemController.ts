import { Request, Response } from "express";
import { getFlutterwaveClient } from "../providers/flutterwave";
import { getPaystackClient } from "../providers/paystack";
import { hasAdminCredentialsActive } from "../config/firebase";

export const getHealth = (req: Request, res: Response) => {
  res.status(200).json({
    status: "ok",
    timestamp: new Date().toISOString(),
  });
};

export const getReady = async (req: Request, res: Response) => {
  try {
    // 1. Verify Firestore Connection
    const databaseReady = hasAdminCredentialsActive;

    // 2. Fast check of provider instances
    const flwClient = getFlutterwaveClient();
    const pstkClient = getPaystackClient();

    const ready = databaseReady && !!flwClient && !!pstkClient;

    if (ready) {
      res.status(200).json({
        status: "ready",
        services: {
          database: "connected",
          flutterwave: "initialized",
          paystack: "initialized",
        },
      });
    } else {
      res.status(503).json({
        status: "not_ready",
        services: {
          database: databaseReady ? "connected" : "offline_fallback",
          flutterwave: flwClient ? "initialized" : "offline",
          paystack: pstkClient ? "initialized" : "offline",
        },
      });
    }
  } catch (error: any) {
    res.status(500).json({
      status: "error",
      message: error.message || "Failed to execute readiness checks.",
    });
  }
};

export const getLive = (req: Request, res: Response) => {
  res.status(200).json({
    status: "live",
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
  });
};
