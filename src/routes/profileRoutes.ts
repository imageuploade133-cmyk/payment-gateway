import { Router, Request, Response } from "express";
import { KycService } from "../services/kycService";
import { gatewayAuthMiddleware, AuthenticatedRequest } from "../middleware/auth";
import logger from "../config/logger";

const router = Router();

/**
 * Endpoint to securely process user KYC submissions.
 * Submits the user documents into the PENDING state waiting for human administration review.
 * Does NOT perform self-approvals, does NOT provision bank accounts.
 * Derive the userId strictly from the authenticated Firebase Token's UID to prevent spoofing.
 */
router.post("/verify-kyc", gatewayAuthMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const reqId = req.requestId;
  try {
    const {
      firstName,
      lastName,
      documentType,
      documentNumber,
      email,
      phone,
      capturedSelfie,
      livenessChallenge,
    } = req.body;

    // Use token UID directly to guarantee secure user boundaries
    const userId = req.user?.uid;

    if (!userId) {
      res.status(401).json({
        success: false,
        message: "Unauthorized: Missing authenticated user token.",
      });
      return;
    }

    if (!firstName || !lastName || !documentType || !documentNumber) {
      res.status(400).json({
        success: false,
        message: "Missing required KYC parameters: firstName, lastName, documentType, documentNumber are required.",
      });
      return;
    }

    if (documentType !== "bvn" && documentType !== "nin") {
      res.status(400).json({
        success: false,
        message: "Invalid documentType. Must be either 'bvn' or 'nin'.",
      });
      return;
    }

    const verificationResult = await KycService.submitKyc({
      userId,
      firstName,
      lastName,
      documentType,
      documentNumber,
      email: email || "",
      phone: phone || "",
      capturedSelfie,
      livenessChallenge,
    });

    res.status(200).json({
      success: true,
      message: "KYC submitted successfully. Your verification is now PENDING administrator approval.",
      status: "PENDING",
    });
  } catch (error: any) {
    logger.error(`[ProfileRoutes] verify-kyc failure: ${error.message} | reqId=${reqId}`);

    // Send KYC Rejected Notification
    try {
      const { NotificationService } = require("../services/notificationService");
      const targetUserId = req.user?.uid;
      if (targetUserId) {
        await NotificationService.sendPushNotification(targetUserId, {
          title: "❌ KYC Identity Rejected",
          body: `Identity verification failed: ${error.message || "Please check your document details."}`,
          type: "security",
          url: "/profile",
        });
      }
    } catch (notifErr: any) {
      logger.error(`[ProfileRoutes Exception] Failed to send KYC rejection notification: ${notifErr.message}`);
    }

    res.status(400).json({
      success: false,
      message: error.message || "Identity verification failed.",
    });
  }
});

export default router;
