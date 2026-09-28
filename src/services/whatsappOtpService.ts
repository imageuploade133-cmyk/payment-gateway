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
   * Auto-provisions / registers an API key on the WhatsAPI gateway database.
   */
  private static async ensureApiKeyOnGateway(
    apiUrl: string,
    apiKey: string,
    instanceId: string,
    adminUsername?: string,
    adminPassword?: string
  ): Promise<boolean> {
    if (!apiUrl || !apiKey) return false;

    try {
      const urlObj = new URL(apiUrl);
      const baseUrl = `${urlObj.protocol}//${urlObj.host}`;
      const createApiKeyEndpoint = `${baseUrl}/api/email/apikeys`;

      const createBody = {
        name: "E-Global Pay Gateway Key",
        customSecret: apiKey,
        customId: instanceId || apiKey,
        scopes: ["email.send", "email.otp", "email.templates", "email.logs", "whatsapp.send"],
        daily_quota: 2000000,
      };

      const sendCreateReq = async (cookie?: string, token?: string) => {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (cookie) headers["Cookie"] = cookie;
        if (token) headers["Authorization"] = `Bearer ${token}`;

        return await fetch(createApiKeyEndpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(createBody),
        });
      };

      let res = await sendCreateReq();
      if (res.ok) {
        logger.info(`[WhatsAppOtpService] Successfully auto-registered API key on gateway.`);
        return true;
      }

      if ((res.status === 401 || res.status === 403) && adminUsername && adminPassword) {
        logger.info(`[WhatsAppOtpService] Auth required for key registration. Attempting admin login...`);
        const loginEndpoints = [`${baseUrl}/api/auth/login`, `${baseUrl}/auth/login`, `${baseUrl}/api/login`, `${baseUrl}/login`];

        let sessionCookie = "";
        let acquiredToken = "";

        for (const ep of loginEndpoints) {
          try {
            const loginRes = await fetch(ep, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                username: adminUsername,
                email: adminUsername,
                password: adminPassword,
              }),
            });

            if (loginRes.ok) {
              const setCookieHeader = loginRes.headers.get("set-cookie");
              if (setCookieHeader) sessionCookie = setCookieHeader;

              const loginData = await loginRes.json().catch(() => ({}));
              acquiredToken = loginData.token || loginData.apiKey || loginData.key || loginData.accessToken || "";
              break;
            }
          } catch {}
        }

        if (acquiredToken || sessionCookie) {
          const retryRes = await sendCreateReq(sessionCookie, acquiredToken);
          if (retryRes.ok) {
            logger.info(`[WhatsAppOtpService] Successfully registered API key via admin session.`);
            return true;
          }
        }
      }

      return false;
    } catch (err: any) {
      logger.warn(`[WhatsAppOtpService] Exception registering API key on gateway: ${err.message}`);
      return false;
    }
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

    let whatsappApiUrl = env.WHATSAPP_API_URL;
    let whatsappApiKey = env.WHATSAPP_API_KEY;
    let whatsappInstanceId = env.WHATSAPP_INSTANCE_ID;
    let whatsappAdminUsername = env.WHATSAPP_ADMIN_USERNAME;
    let whatsappAdminPassword = env.WHATSAPP_ADMIN_PASSWORD;

    // Dynamically check Firestore config if available
    try {
      if (adminDb) {
        const waDoc = await adminDb.collection("config").doc("whatsapp_api").get();
        if (waDoc.exists) {
          const waData = waDoc.data();
          if (waData?.whatsappApiUrl) whatsappApiUrl = waData.whatsappApiUrl;
          if (waData?.whatsappApiKey) whatsappApiKey = waData.whatsappApiKey;
          if (waData?.whatsappInstanceId) whatsappInstanceId = waData.whatsappInstanceId;
          if (waData?.whatsappAdminUsername) whatsappAdminUsername = waData.whatsappAdminUsername;
          if (waData?.whatsappAdminPassword) whatsappAdminPassword = waData.whatsappAdminPassword;
        } else {
          const emailDoc = await adminDb.collection("config").doc("email_connect").get();
          if (emailDoc.exists) {
            const emailData = emailDoc.data();
            if (emailData?.whatsappApiUrl || emailData?.emailApiUrl) {
              whatsappApiUrl = emailData.whatsappApiUrl || emailData.emailApiUrl;
            }
            if (emailData?.whatsappApiKey || emailData?.emailApiKey) {
              whatsappApiKey = emailData.whatsappApiKey || emailData.emailApiKey;
            }
            if (emailData?.whatsappInstanceId || emailData?.emailInstanceId) {
              whatsappInstanceId = emailData.whatsappInstanceId || emailData.emailInstanceId;
            }
            if (emailData?.emailAdminUsername) whatsappAdminUsername = emailData.emailAdminUsername;
            if (emailData?.emailAdminPassword) whatsappAdminPassword = emailData.emailAdminPassword;
          }
        }
      }
    } catch (dbErr: any) {
      logger.warn(`[WhatsAppOtpService] Dynamic config fetch warning: ${dbErr.message}`);
    }

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
      `Your E-Global Pay Access OTP verification code is: *${rawOtp}*. It expires in 10 minutes. Do not share this code with anyone.`,
      `Security Alert: Use *${rawOtp}* to verify your E-Global Pay account phone number. This OTP is valid for 10 minutes.`,
      `Your secure one-time passcode is *${rawOtp}* for E-Global Pay registration. Please enter this code to complete verification.`
    ];
    const messageText = messageTemplates[crypto.randomInt(0, messageTemplates.length)];

    // 4. Send Message via WhatsApp Gateway S2S HTTP request
    let sendSuccess = false;
    let apiErrorMsg = "";

    if (whatsappApiUrl && whatsappApiKey && whatsappInstanceId) {
      try {
        // Construct canonical target URL endpoint: ensure it points to /api/send/text
        let targetUrl = whatsappApiUrl.trim().replace(/\/+$/, "");
        targetUrl = targetUrl.replace("whatsapp-5fda.onrender.com", "whatsapp-b5os.onrender.com");

        if (!targetUrl.includes("/api/send/text") && !targetUrl.includes("/send/text")) {
          if (targetUrl.endsWith("/api")) {
            targetUrl = `${targetUrl}/send/text`;
          } else {
            targetUrl = `${targetUrl}/api/send/text`;
          }
        }

        const payload = {
          number: cleanPhone,
          message: messageText,
          instanceId: whatsappInstanceId,
        };

        logger.info(`[WhatsAppOtpService] Dispatching OTP message to WhatsApp gateway endpoint: ${targetUrl} | phone=${cleanPhone}`);

        const dispatchReq = async (apiKeyToUse: string, cookieToUse?: string, tokenToUse?: string) => {
          const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "X-API-Key": apiKeyToUse,
            "x-api-key": apiKeyToUse,
            "apikey": apiKeyToUse,
            "X-Instance-ID": whatsappInstanceId,
            "Authorization": tokenToUse ? `Bearer ${tokenToUse}` : `Bearer ${apiKeyToUse}`,
          };
          if (cookieToUse) headers["Cookie"] = cookieToUse;

          return await fetch(targetUrl, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
          });
        };

        let res = await dispatchReq(whatsappApiKey);

        if (res.ok) {
          sendSuccess = true;
          logger.info(`[WhatsAppOtpService] OTP successfully sent via WhatsApp API.`);
        } else {
          let textResponse = await res.text();
          apiErrorMsg = `Gateway responded with status ${res.status}: ${textResponse}`;
          logger.error(`[WhatsAppOtpService] WhatsApp API failed: ${apiErrorMsg}`);

          // If 401 or 403 Forbidden / Invalid API Key occurs, attempt auto-registering the key on the gateway
          if (res.status === 401 || res.status === 403 || textResponse.includes("Forbidden") || textResponse.includes("Invalid API Key")) {
            logger.info(`[WhatsAppOtpService] 401/403 detected. Attempting to auto-provision API key on gateway...`);
            const provisioned = await this.ensureApiKeyOnGateway(
              whatsappApiUrl,
              whatsappApiKey,
              whatsappInstanceId,
              whatsappAdminUsername,
              whatsappAdminPassword
            );

            if (provisioned) {
              logger.info(`[WhatsAppOtpService] Key provisioned successfully. Retrying WhatsApp dispatch...`);
              const retryRes = await dispatchReq(whatsappApiKey);
              if (retryRes.ok) {
                sendSuccess = true;
                logger.info(`[WhatsAppOtpService] OTP successfully sent after auto-provisioning API key.`);
              } else {
                const retryText = await retryRes.text();
                logger.error(`[WhatsAppOtpService] Retry after provisioning failed: ${retryRes.status} ${retryText}`);
              }
            }
          }
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
