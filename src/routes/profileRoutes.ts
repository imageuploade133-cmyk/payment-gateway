import { Router, Request, Response } from "express";
import { KycService } from "../services/kycService";
import { gatewayAuthMiddleware } from "../middleware/auth";
import logger from "../config/logger";

const router = Router();

/**
 * Endpoint to securely process user KYC verification and liveness challenges.
 * This endpoint executes all Firestore writes and static virtual account provisioning on the gateway.
 */
router.post("/verify-kyc", gatewayAuthMiddleware, async (req: Request, res: Response) => {
  const reqId = req.requestId;
  try {
    const {
      userId,
      firstName,
      lastName,
      documentType,
      documentNumber,
      faceConfidence,
      email,
      phone,
      capturedSelfie,
      livenessChallenge,
    } = req.body;

    if (!userId || !firstName || !lastName || !documentType || !documentNumber) {
      res.status(400).json({
        success: false,
        message: "Missing required KYC parameters: userId, firstName, lastName, documentType, documentNumber are required.",
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

    const verificationResult = await KycService.verifyKyc({
      userId,
      firstName,
      lastName,
      documentType,
      documentNumber,
      faceConfidence: faceConfidence || 0.95, // default simulation score
      email: email || "",
      phone: phone || "",
      capturedSelfie,
      livenessChallenge,
    });

    res.status(200).json({
      success: true,
      message: "KYC and Face Verification successful! Your static virtual account number has been allocated.",
      data: verificationResult.ngnAccount, // Returns standard NGN account object
      usdAccount: verificationResult.usdAccount, // Returns standard USD account object
    });
  } catch (error: any) {
    logger.error(`[ProfileRoutes] verify-kyc failure: ${error.message} | reqId=${reqId}`);
    res.status(400).json({
      success: false,
      message: error.message || "Identity verification failed.",
    });
  }
});

export default router;
