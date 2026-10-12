import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import logger from "../config/logger";
import { firebase, adminDb } from "../config/firebase";

export interface AuthenticatedRequest extends Request {
  user?: any;
  adminUser?: any;
}

/**
 * Enterprise-grade gateway authentication middleware.
 * Supports API Key validation (with zero-downtime key rotation) and extensible JWT validation.
 */
export async function gatewayAuthMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const reqId = req.requestId;

  // 1. Extract credentials from headers
  const apiKeyHeader = req.headers["x-api-key"] as string;
  const authHeader = req.headers.authorization;

  let providedKey = apiKeyHeader;
  let providedToken = "";

  if (authHeader && authHeader.startsWith("Bearer ")) {
    const value = authHeader.substring(7).trim();
    if (value.split(".").length === 3) {
      // Looks like a JWT token structure (header.payload.signature)
      providedToken = value;
    } else {
      // Treat as API Key
      providedKey = value;
    }
  }

  const path = req.originalUrl || req.path || req.url || "";
  const isTransferRoute = path.includes("/transfer") || path.includes("/bulk-transfer");

  // 2. JWT / Firebase Authentication path
  if (providedToken) {
    if (firebase.app) {
      try {
        const { getAuth } = require("firebase-admin/auth");
        const decoded = await getAuth(firebase.app).verifyIdToken(providedToken);
        const uid = decoded?.uid;

        if (!uid) {
          logger.warn(`[Auth] Firebase token missing UID claim | reqId=${reqId}`);
          res.status(401).json({
            success: false,
            code: "REVOKED_SESSION",
            message: "Unauthorized: Invalid token claims.",
          });
          return;
        }

        req.user = { ...decoded, firebaseAuth: true };

        // Check if route is an auth/recovery endpoint (PIN reset, OTP send/verify, session setup)
        const isAuthExempt = path.includes("/auth/") || path.includes("pin-reset-otp") || path.includes("pin-verify-otp") || path.includes("send-otp") || path.includes("verify-otp");

        if (!isAuthExempt) {
          // Server-authoritative session enforcement
          const providedSessionId = (req.headers["x-session-id"] || req.headers["X-Session-ID"]) as string;

          if (!providedSessionId) {
            logger.warn(`[Auth] REVOKED_SESSION: Missing X-Session-ID header for user ${uid} | reqId=${reqId}`);
            res.status(401).json({
              success: false,
              code: "REVOKED_SESSION",
              message: "Missing session ID. You have been logged out on this device.",
            });
            return;
          }

          if (!adminDb) {
            logger.error(`[Auth] REVOKED_SESSION: Firestore adminDb unavailable during session check for user ${uid} | reqId=${reqId}`);
            res.status(401).json({
              success: false,
              code: "REVOKED_SESSION",
              message: "Session validation failed. Please sign in again.",
            });
            return;
          }

          try {
            const userDoc = await adminDb.collection("users").doc(uid).get();

            if (!userDoc.exists) {
              logger.warn(`[Auth] REVOKED_SESSION: User record not found for user ${uid} | reqId=${reqId}`);
              res.status(401).json({
                success: false,
                code: "REVOKED_SESSION",
                message: "Account record not found.",
              });
              return;
            }

            const activeSessionId = userDoc.data()?.activeSessionId;

            if (!activeSessionId || providedSessionId !== activeSessionId) {
              logger.warn(`[Auth] REVOKED_SESSION: Session mismatch or missing activeSessionId for user ${uid}. Provided '${providedSessionId}', Active '${activeSessionId}' | reqId=${reqId}`);
              res.status(401).json({
                success: false,
                code: "REVOKED_SESSION",
                message: "Your account was signed in on another device or has no active session. You have been logged out on this device.",
              });
              return;
            }
          } catch (sErr: any) {
            logger.error(`[Auth] REVOKED_SESSION: Session check exception for user ${uid}: ${sErr.message} | reqId=${reqId}`);
            res.status(401).json({
              success: false,
              code: "REVOKED_SESSION",
              message: "Session validation failed.",
            });
            return;
          }
        }

        logger.info(`[Auth] Firebase ID Token & Session successfully verified | user=${uid} | reqId=${reqId}`);
        return next();
      } catch (fbError: any) {
        logger.warn(`[Auth] Firebase token verification failed | error=${fbError.message} | reqId=${reqId}`);
        res.status(401).json({
          success: false,
          code: "REVOKED_SESSION",
          message: "Unauthorized: Invalid or expired Firebase ID token.",
        });
        return;
      }
    }

    if (isTransferRoute) {
      logger.warn(`[Auth] Transfer rejected: Firebase authentication service unavailable | reqId=${reqId}`);
      res.status(401).json({
        success: false,
        code: "REVOKED_SESSION",
        message: "Unauthorized: Firebase authentication service is unavailable for transfers.",
      });
      return;
    }

    try {
      const decoded = jwt.verify(providedToken, env.JWT_SECRET) as jwt.JwtPayload & { uid?: string };
      req.user = decoded;

      // Transfer execution must enforce the same server-side session check on the
      // JWT fallback path as it does for Firebase ID tokens.
      const path = req.originalUrl || req.path || req.url || "";
      if (path.split("?")[0] === "/api/flutterwave/transfer") {
        const uid = typeof decoded.uid === "string" ? decoded.uid.trim() : "";
        const providedSessionId = req.headers["x-session-id"] as string | undefined;

        if (!uid || !providedSessionId || !adminDb) {
          res.status(401).json({
            success: false,
            code: "REVOKED_SESSION",
            message: "Session validation failed. Please sign in again.",
          });
          return;
        }

        const userDoc = await adminDb.collection("users").doc(uid).get();
        if (!userDoc.exists) {
          res.status(401).json({
            success: false,
            code: "REVOKED_SESSION",
            message: "Account record not found.",
          });
          return;
        }

        const activeSessionId = userDoc.data()?.activeSessionId;
        if (activeSessionId && providedSessionId !== activeSessionId) {
          res.status(401).json({
            success: false,
            code: "REVOKED_SESSION",
            message: "Your account was signed in on another device. You have been logged out on this device.",
          });
          return;
        }
      }

      logger.info(`[Auth] JWT successfully verified | user=${(decoded as any).uid || (decoded as any).sub || "unknown"} | reqId=${reqId}`);
      return next();
    } catch (error: any) {
      logger.warn(`[Auth] JWT verification failed | error=${error.message} | reqId=${reqId}`);
      res.status(401).json({
        success: false,
        message: "Unauthorized: Invalid or expired authentication token.",
      });
      return;
    }
  }

  // 3. API Key Authentication path (Primary S2S verification)
  if (!providedKey) {
    logger.warn(`[Auth] Request missing authentication credentials | route=${req.method} ${req.url} | reqId=${reqId}`);
    res.status(401).json({
      success: false,
      message: "Unauthorized: Missing authentication credentials (API Key or Bearer Token).",
    });
    return;
  }

  // Support Key Rotation: Check if the provided key matches ANY of the active keys
  const isValidKey = env.GATEWAY_API_KEYS.includes(providedKey);

  if (!isValidKey) {
    // Mask the provided key for logging to protect against secret leakages in log files
    const maskedKey = providedKey.length > 6
      ? `${providedKey.slice(0, 3)}...${providedKey.slice(-3)}`
      : "***";

    logger.warn(
      `[Auth] Invalid API Key provided | maskedKey=${maskedKey} | route=${req.method} ${req.url} | reqId=${reqId}`
    );

    res.status(401).json({
      success: false,
      message: "Unauthorized: Invalid API Key.",
    });
    return;
  }



  logger.debug(`[Auth] API Key authenticated successfully | reqId=${reqId}`);
  next();
}
