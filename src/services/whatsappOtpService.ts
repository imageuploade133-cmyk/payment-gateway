import crypto from "crypto";
import adminDb from "../config/firebase";
import logger from "../config/logger";
import { env } from "../config/env";

export interface OtpSession {
  phoneNumber: string;
  otpHash: string;
  type: string;
  createdAt: string;
  expiresAt: string;
  cooldownUntil: string;
  failedAttempts: number;
  verified: boolean;
}

export class WhatsAppOtpService {
  /**
   * Generates a cryptographically secure 6-digit OTP
   */
  private static generateOtp(): string {
    return crypto.randomInt(100000, 999999).toString();
  }

  /**
   * Hashes the OTP using SHA-256
   */
  private static hashOtp(otp: string): string {
    return crypto.createHash("sha256").update(otp).digest("hex");
  }

  /**
   * Clean up expired OTP sessions from Firestore
   */
  public static async cleanupExpiredOtps(): Promise<void> {
    try {
      if (!adminDb) return;
      const now = new Date().toISOString();
      const expiredSnap = await adminDb
        .collection("otp_sessions")
        .where("expiresAt", "<", now)
        .get();

      if (expiredSnap.empty) return;

      const batch = adminDb.batch();
      expiredSnap.docs.forEach((doc) => {
        batch.delete(doc.ref);
      });
      await batch.commit();
      logger.info(`[WhatsAppOtpService] Cleaned up ${expiredSnap.size} expired OTP sessions.`);
    } catch (err: any) {
      logger.error(`[WhatsAppOtpService] Failed to cleanup expired OTPs: ${err.message}`);
    }
  }

  /**
   * Sends OTP via external WhatsApp gateway
   */
  public static async sendOtp(phoneNumber: string, type: string = "signup"): Promise<{ message: string; devOtp?: string }> {
    const isProd = env.NODE_ENV === "production";
    const whatsappApiUrl = env.WHATSAPP_API_URL;
    const whatsappApiKey = env.WHATSAPP_API_KEY;
    const whatsappInstanceId = env.WHATSAPP_INSTANCE_ID;

    // Validate configuration
    if (!whatsappApiUrl || !whatsappApiKey || !whatsappInstanceId) {
      const configError = "Configuration Error: Missing WHATSAPP_API_URL, WHATSAPP_API_KEY, or WHATSAPP_INSTANCE_ID.";
      if (!isProd) {
        logger.warn(`[WhatsAppOtpService] ${configError} (Development Mode fallback enabled)`);
      } else {
        logger.error(`[WhatsAppOtpService] ${configError}`);
        throw new Error("WhatsApp Service configuration is incomplete. Please contact support.");
      }
    }

    if (!adminDb) {
      throw new Error("Firestore Admin Database not initialized.");
    }

    // Standardize phone format (e.g., must be digits-only, no leading + or spaces)
    const cleanPhone = phoneNumber.replace(/\D/g, "");

    // 1. Check existing session for rate limits and cooldowns
    const sessionDocRef = adminDb.collection("otp_sessions").doc(cleanPhone);
    const sessionSnap = await sessionDocRef.get();
    const now = new Date();

    if (sessionSnap.exists) {
      const data = sessionSnap.data() as OtpSession;
      const cooldownTime = new Date(data.cooldownUntil);
      if (now < cooldownTime) {
        const waitSec = Math.ceil((cooldownTime.getTime() - now.getTime()) / 1000);
        throw new Error(`Rate limit exceeded. Please wait ${waitSec}s before requesting a new OTP.`);
      }
    }

    // 2. Generate new OTP
    const rawOtp = this.generateOtp();
    const otpHash = this.hashOtp(rawOtp);

    // 3. Build templates/cooldown timelines
    const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString(); // 10 minutes expiry
    const cooldownUntil = new Date(now.getTime() + 60 * 1000).toISOString(); // 60 seconds cooldown

    // Selected random message templates to secure against automated pattern detection and spam filtering
    const messageTemplates = [
      `Your E-Tech Access OTP verification code is: *${rawOtp}*. It expires in 10 minutes. Do not share this code with anyone.`,
      `Security Alert: Use *${rawOtp}* to verify your E-Tech account phone number. This OTP is valid for 10 minutes.`,
      `Your secure one-time passcode is *${rawOtp}* for E-Tech registration. Please enter this code to complete verification.`
    ];
    const messageText = messageTemplates[crypto.randomInt(0, messageTemplates.length)];

    // 4. Send Message via WhatsApp Gateway S2S HTTP request
    let sendSuccess = false;
    let apiErrorMsg = "";

    if (whatsappApiUrl && whatsappApiKey && whatsappInstanceId) {
      try {
        const payload = {
          number: cleanPhone,
          message: messageText,
        };

        logger.info(`[WhatsAppOtpService] Dispatching OTP message to WhatsApp gateway... | phone=${cleanPhone}`);

        const res = await fetch(whatsappApiUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": whatsappApiKey,
            "X-Instance-ID": whatsappInstanceId,
          },
          body: JSON.stringify(payload),
        });

        if (res.ok) {
          sendSuccess = true;
          logger.info(`[WhatsAppOtpService] OTP successfully sent via WhatsApp API.`);
        } else {
          const textResponse = await res.text();
          apiErrorMsg = `Gateway responded with status ${res.status}: ${textResponse}`;
          logger.error(`[WhatsAppOtpService] WhatsApp API failed: ${apiErrorMsg}`);
        }
      } catch (err: any) {
        apiErrorMsg = err.message;
        logger.error(`[WhatsAppOtpService] Connection to WhatsApp gateway failed: ${apiErrorMsg}`);
      }
    }

    // If in production and API dispatch failed, we raise a server error
    if (isProd && !sendSuccess) {
      throw new Error(`WhatsApp Dispatch Failed: ${apiErrorMsg || "No response from gateway"}`);
    }

    // 5. Update/Save Session in Firestore securely
    const newSession: OtpSession = {
      phoneNumber: cleanPhone,
      otpHash,
      type,
      createdAt: now.toISOString(),
      expiresAt,
      cooldownUntil,
      failedAttempts: 0,
      verified: false,
    };

    await sessionDocRef.set(newSession);

    // Audit Log Entry
    await adminDb.collection("otp_audits").add({
      phoneNumber: cleanPhone,
      type,
      action: "GENERATE",
      status: "SUCCESS",
      timestamp: now.toISOString(),
    });

    // In development mode, we can return the OTP code for local debugging/tests
    if (!isProd) {
      logger.info(`[WhatsAppOtpService] [DEV MODE] OTP generated: ${rawOtp} for ${cleanPhone}`);
      return {
        message: "OTP sent successfully (Development Mode)",
        devOtp: rawOtp,
      };
    }

    return {
      message: "OTP sent successfully via WhatsApp.",
    };
  }

  /**
   * Verifies the OTP code
   */
  public static async verifyOtp(phoneNumber: string, otpCode: string, type: string = "signup"): Promise<{ success: boolean; message: string }> {
    if (!adminDb) {
      throw new Error("Firestore Admin Database not initialized.");
    }

    const cleanPhone = phoneNumber.replace(/\D/g, "");
    const sessionDocRef = adminDb.collection("otp_sessions").doc(cleanPhone);
    const sessionSnap = await sessionDocRef.get();

    if (!sessionSnap.exists) {
      throw new Error("No active verification session found. Please request a new OTP.");
    }

    const data = sessionSnap.data() as OtpSession;
    const now = new Date();

    // 1. Check if expired
    if (now > new Date(data.expiresAt)) {
      await sessionDocRef.delete();
      throw new Error("Verification code has expired. Please request a new OTP.");
    }

    // 2. Validate hashed OTP
    const hashedProvided = this.hashOtp(otpCode.trim());
    if (hashedProvided !== data.otpHash) {
      const updatedFailedAttempts = (data.failedAttempts || 0) + 1;

      // Audit Log for failure
      await adminDb.collection("otp_audits").add({
        phoneNumber: cleanPhone,
        type,
        action: "VERIFY_FAILED",
        timestamp: now.toISOString(),
        attemptCount: updatedFailedAttempts,
      });

      if (updatedFailedAttempts >= 3) {
        // Brute-force lockout: invalidate session permanently
        await sessionDocRef.delete();
        throw new Error("Too many failed attempts. This verification session has been terminated. Please generate a new OTP.");
      } else {
        await sessionDocRef.update({ failedAttempts: updatedFailedAttempts });
        const remaining = 3 - updatedFailedAttempts;
        throw new Error(`Incorrect verification code. You have ${remaining} attempts remaining before lockout.`);
      }
    }

    // 3. Complete verification & delete or mark verified
    // We mark it as verified so that registration completes successfully and checks this verified session
    await sessionDocRef.update({
      verified: true,
      expiresAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(), // Allow registration within 15 minutes
    });

    // Audit Log for success
    await adminDb.collection("otp_audits").add({
      phoneNumber: cleanPhone,
      type,
      action: "VERIFY_SUCCESS",
      timestamp: now.toISOString(),
    });

    return {
      success: true,
      message: "WhatsApp OTP verified successfully.",
    };
  }
}
