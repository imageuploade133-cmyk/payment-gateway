import { Router, Request, Response } from "express";
import { WhatsAppOtpService } from "../services/whatsappOtpService";
import { EmailOtpService } from "../services/emailOtpService";
import { gatewayAuthMiddleware } from "../middleware/auth";
import adminDb from "../config/firebase";
import logger from "../config/logger";

const router = Router();

/**
 * Endpoint to generate and send a WhatsApp OTP
 * Protected via S2S gateway authentication
 */
router.post("/send-otp", gatewayAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const { phoneNumber, type } = req.body;

    if (!phoneNumber) {
      res.status(400).json({ success: false, message: "phoneNumber parameter is required." });
      return;
    }

    const result = await WhatsAppOtpService.sendOtp(phoneNumber, type || "signup");
    res.status(200).json({
      success: true,
      message: result.message,
      // In non-production environments, we return the code securely for automated tests/development verification
      ...(result.devOtp ? { devOtpCode: result.devOtp } : {}),
    });
  } catch (error: any) {
    logger.error(`[AuthRoutes] send-otp failure: ${error.message}`);
    res.status(400).json({ success: false, message: error.message });
  }
});

/**
 * Endpoint to verify a received WhatsApp OTP
 * Protected via S2S gateway authentication
 */
router.post("/verify-otp", gatewayAuthMiddleware, async (req: Request, res: Response) => {
  try {
    const { phoneNumber, otp, type } = req.body;

    if (!phoneNumber || !otp) {
      res.status(400).json({ success: false, message: "phoneNumber and otp are required parameters." });
      return;
    }

    const result = await WhatsAppOtpService.verifyOtp(phoneNumber, otp, type || "signup");
    res.status(200).json({
      success: true,
      message: result.message,
    });
  } catch (error: any) {
    logger.error(`[AuthRoutes] verify-otp failure: ${error.message}`);
    res.status(400).json({ success: false, message: error.message });
  }
});

/**
 * Endpoint to trigger a PIN reset OTP based on user token
 * Authenticates user via Firebase ID Token, resolves phone/email, and dispatches OTP
 */
router.post("/pin-reset-otp", gatewayAuthMiddleware, async (req: any, res: Response) => {
  try {
    const uid = req.user?.uid;
    const { channel } = req.body;

    if (!uid) {
      res.status(401).json({ success: false, message: "Unauthorized: Missing user authentication token." });
      return;
    }

    if (channel === "email") {
      const authEmail = req.user?.email;
      const result = await EmailOtpService.sendPinResetOtp(uid, authEmail);
      res.status(200).json({
        success: true,
        message: result.message || "PIN reset OTP sent to registered email address.",
        ...(result.devOtp ? { devOtpCode: result.devOtp } : {}),
      });
      return;
    }

    // Default or channel === "whatsapp": Keep existing WhatsApp implementation unchanged
    if (!adminDb) {
      res.status(500).json({ success: false, message: "Firestore database not configured." });
      return;
    }

    const userSnap = await adminDb.collection("users").doc(uid).get();
    if (!userSnap.exists) {
      res.status(404).json({ success: false, message: "User profile not found." });
      return;
    }

    const userData = userSnap.data();
    if (!userData || !userData.phoneNumber) {
      res.status(400).json({ success: false, message: "No registered phone number found on this profile." });
      return;
    }

    const fullPhone = userData.phoneNumber;
    const result = await WhatsAppOtpService.sendOtp(fullPhone, "pin_reset");

    res.status(200).json({
      success: true,
      message: result.message || "PIN reset OTP sent to registered WhatsApp number.",
      ...(result.devOtp ? { devOtpCode: result.devOtp } : {}),
    });
  } catch (error: any) {
    logger.error(`[AuthRoutes] pin-reset-otp failure: ${error.message}`);
    res.status(400).json({ success: false, message: error.message });
  }
});

/**
 * Endpoint to verify PIN reset OTP based on user token
 * Authenticates user via Firebase ID Token, resolves session, and verifies OTP
 */
router.post("/pin-verify-otp", gatewayAuthMiddleware, async (req: any, res: Response) => {
  try {
    const uid = req.user?.uid;
    const { otpCode, channel } = req.body;

    if (!uid) {
      res.status(401).json({ success: false, message: "Unauthorized: Missing user authentication token." });
      return;
    }

    if (!otpCode) {
      res.status(400).json({ success: false, message: "otpCode parameter is required." });
      return;
    }

    if (channel === "email") {
      const result = await EmailOtpService.verifyPinResetOtp(uid, otpCode);
      res.status(200).json({
        success: true,
        message: result.message || "Email OTP verified successfully.",
      });
      return;
    }

    // Default or channel === "whatsapp": Keep existing WhatsApp verification implementation unchanged
    if (!adminDb) {
      res.status(500).json({ success: false, message: "Firestore database not configured." });
      return;
    }

    const userSnap = await adminDb.collection("users").doc(uid).get();
    if (!userSnap.exists) {
      res.status(404).json({ success: false, message: "User profile not found." });
      return;
    }

    const userData = userSnap.data();
    if (!userData || !userData.phoneNumber) {
      res.status(400).json({ success: false, message: "No registered phone number found on this profile." });
      return;
    }

    const fullPhone = userData.phoneNumber;
    const result = await WhatsAppOtpService.verifyOtp(fullPhone, otpCode, "pin_reset");

    res.status(200).json({
      success: true,
      message: result.message || "WhatsApp OTP verified successfully.",
    });
  } catch (error: any) {
    logger.error(`[AuthRoutes] pin-verify-otp failure: ${error.message}`);
    res.status(400).json({ success: false, message: error.message });
  }
});

export default router;
