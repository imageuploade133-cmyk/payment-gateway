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
   * Resolves the canonical API key for a WhatsApp instance by querying the WhatsAPI gateway
   * using admin credentials if necessary.
   */
  private static async resolveGatewayInstanceKey(
    apiUrl: string,
    targetInstanceId: string,
    fallbackApiKey: string,
    adminUsername?: string,
    adminPassword?: string
  ): Promise<{ resolvedApiKey: string; sessionCookie?: string }> {
    if (!apiUrl) return { resolvedApiKey: fallbackApiKey };

    try {
      const urlObj = new URL(apiUrl);
      const baseUrl = `${urlObj.protocol}//${urlObj.host}`;

      if (!adminUsername || !adminPassword) {
        return { resolvedApiKey: fallbackApiKey };
      }

      // 1. Authenticate with WhatsAPI Admin Session
      const loginEndpoints = [`${baseUrl}/api/login`, `${baseUrl}/login`, `${baseUrl}/api/auth/login`];
      let sessionCookie = "";

      for (const ep of loginEndpoints) {
        try {
          const loginRes = await fetch(ep, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              username: adminUsername,
              password: adminPassword,
            }),
          });

          if (loginRes.ok) {
            const setCookieHeader = loginRes.headers.get("set-cookie");
            if (setCookieHeader) {
              sessionCookie = setCookieHeader.split(";")[0];
              logger.info(`[WhatsAppOtpService] Successfully logged in as admin to WhatsAPI gateway at ${ep}`);
              break;
            }
          }
        } catch {}
      }

      if (!sessionCookie) {
        logger.warn(`[WhatsAppOtpService] Could not establish admin session on WhatsAPI gateway.`);
        return { resolvedApiKey: fallbackApiKey };
      }

      // 2. Query list of WhatsApp instances to retrieve the matching instance's actual API key
      const instRes = await fetch(`${baseUrl}/api/instances`, {
        headers: { Cookie: sessionCookie },
      });

      if (instRes.ok) {
        const instList: any = await instRes.json().catch(() => []);
        if (Array.isArray(instList) && instList.length > 0) {
          // Find matching instance by ID or name, or fallback to the first active connected instance
          let matchedInst = instList.find(
            (i: any) => i.id === targetInstanceId || i.name === targetInstanceId
          );

          if (!matchedInst) {
            matchedInst = instList.find((i: any) => i.status === "connected") || instList[0];
          }

          if (matchedInst && matchedInst.apiKey) {
            logger.info(`[WhatsAppOtpService] Resolved real gateway API key for instance '${matchedInst.id}': ${matchedInst.apiKey.slice(0, 8)}...`);
            return { resolvedApiKey: matchedInst.apiKey, sessionCookie };
          }
        }
      }

      // 3. If instance not found or needs registration with fallbackApiKey, start/create instance
      try {
        const startRes = await fetch(`${baseUrl}/api/instances`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: sessionCookie,
          },
          body: JSON.stringify({
            id: targetInstanceId,
            name: targetInstanceId,
            apiKey: fallbackApiKey,
          }),
        });

        if (startRes.ok) {
          const startData: any = await startRes.json().catch(() => ({}));
          const key = startData?.instance?.apiKey || fallbackApiKey;
          logger.info(`[WhatsAppOtpService] Created/Started instance '${targetInstanceId}' on WhatsAPI gateway.`);
          return { resolvedApiKey: key, sessionCookie };
        }
      } catch (startErr: any) {
        logger.warn(`[WhatsAppOtpService] Could not auto-create instance on gateway: ${startErr.message}`);
      }

      return { resolvedApiKey: fallbackApiKey, sessionCookie };
    } catch (err: any) {
      logger.warn(`[WhatsAppOtpService] Exception resolving instance key on gateway: ${err.message}`);
      return { resolvedApiKey: fallbackApiKey };
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
    if (!whatsappApiUrl || !whatsappInstanceId) {
      const configError = "Configuration Error: Missing WHATSAPP_API_URL or WHATSAPP_INSTANCE_ID.";
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

    if (whatsappApiUrl && whatsappInstanceId) {
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
        };

        const dispatchReq = async (apiKeyToUse: string, cookieToUse?: string) => {
          // Strictly send single Header keys to avoid Header duplication merging in fetch
          const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "X-API-Key": apiKeyToUse.trim(),
            "X-Instance-ID": whatsappInstanceId.trim(),
          };
          if (cookieToUse) headers["Cookie"] = cookieToUse;

          return await fetch(targetUrl, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
          });
        };

        logger.info(`[WhatsAppOtpService] Dispatching OTP message to WhatsApp gateway endpoint: ${targetUrl} | phone=${cleanPhone}`);

        let res = await dispatchReq(whatsappApiKey);

        if (res.ok) {
          sendSuccess = true;
          logger.info(`[WhatsAppOtpService] OTP successfully sent via WhatsApp API.`);
        } else {
          let textResponse = await res.text();
          apiErrorMsg = `Gateway responded with status ${res.status}: ${textResponse}`;
          logger.error(`[WhatsAppOtpService] WhatsApp API initial attempt failed: ${apiErrorMsg}`);

          // If 401 or 403 Forbidden / Invalid API Key occurs, query the gateway using admin login to resolve the real instance key
          if (res.status === 401 || res.status === 403 || textResponse.includes("Forbidden") || textResponse.includes("Invalid API Key") || textResponse.includes("Unauthorized")) {
            logger.info(`[WhatsAppOtpService] 401/403 detected. Resolving actual gateway instance key via admin session...`);
            const { resolvedApiKey, sessionCookie } = await this.resolveGatewayInstanceKey(
              whatsappApiUrl,
              whatsappInstanceId,
              whatsappApiKey,
              whatsappAdminUsername,
              whatsappAdminPassword
            );

            if (resolvedApiKey) {
              logger.info(`[WhatsAppOtpService] Retrying WhatsApp dispatch with resolved API key...`);
              const retryRes = await dispatchReq(resolvedApiKey, sessionCookie);
              if (retryRes.ok) {
                sendSuccess = true;
                logger.info(`[WhatsAppOtpService] OTP successfully sent after resolving real instance API key!`);

                // Persist the resolved key to Firestore config so future dispatches succeed immediately
                if (adminDb && resolvedApiKey !== whatsappApiKey) {
                  try {
                    await adminDb.collection("config").doc("whatsapp_api").set(
                      { whatsappApiKey: resolvedApiKey, updatedAt: new Date().toISOString() },
                      { merge: true }
                    );
                    logger.info(`[WhatsAppOtpService] Updated Firestore config/whatsapp_api with working API key.`);
                  } catch {}
                }
              } else {
                const retryText = await retryRes.text();
                logger.error(`[WhatsAppOtpService] Retry with resolved API key failed: ${retryRes.status} ${retryText}`);
                apiErrorMsg = `Gateway responded with status ${retryRes.status}: ${retryText}`;
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
