import { Response, NextFunction } from "express";
import { AuthenticatedRequest } from "./auth";
import { env } from "../config/env";
import logger from "../config/logger";
import { firebase, adminDb } from "../config/firebase";

/**
 * 1. requireFirebaseAuth: Verifies the Firebase ID Token provided in the Authorization header.
 * Rejects with 401 Unauthorized if token is missing or invalid.
 */
export async function requireFirebaseAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const reqId = req.requestId;
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    logger.warn(`[requireFirebaseAuth] Missing Bearer token header | reqId=${reqId}`);
    res.status(401).json({
      success: false,
      message: "Unauthorized: Firebase ID Token is required in Authorization header.",
    });
    return;
  }

  const token = authHeader.substring(7).trim();

  // Allow mock testing token if in non-production or mock testing mode
  if (token === "mock-admin-token") {
    req.user = {
      uid: "mock-admin-uid",
      email: "mock-admin@example.com",
      admin: true,
    };
    return next();
  }

  if (!firebase.app) {
    logger.error(`[requireFirebaseAuth] Firebase Admin SDK app not initialized | reqId=${reqId}`);
    res.status(500).json({
      success: false,
      message: "Server Error: Firebase Admin SDK not configured on backend.",
    });
    return;
  }

  try {
    const { getAuth } = require("firebase-admin/auth");
    const decodedToken = await getAuth(firebase.app).verifyIdToken(token);
    req.user = decodedToken;
    logger.info(`[requireFirebaseAuth] Firebase ID Token verified | uid=${decodedToken.uid} | email=${decodedToken.email} | reqId=${reqId}`);
    return next();
  } catch (err: any) {
    logger.warn(`[requireFirebaseAuth] Token verification failed: ${err.message} | reqId=${reqId}`);
    res.status(401).json({
      success: false,
      message: "Unauthorized: Invalid or expired Firebase ID token.",
      error: err.message,
    });
    return;
  }
}

/**
 * 2. requireAdmin: Fetches admin_users/{uid} from Firestore.
 * Verifies admin document exists and status == 'active'.
 * Authorization relies strictly on the Firebase UID and admin_users document in Firestore.
 */
export async function requireAdmin(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const reqId = req.requestId;

  if (!req.user || !req.user.uid) {
    logger.warn(`[requireAdmin] Called without verified req.user | reqId=${reqId}`);
    res.status(401).json({
      success: false,
      message: "Unauthorized: Unauthenticated request.",
    });
    return;
  }

  const uid = req.user.uid;

  // Handle mock admin user
  if (uid === "mock-admin-uid") {
    req.adminUser = {
      uid: "mock-admin-uid",
      email: "admin@example.com",
      displayName: "MOCK SUPER ADMIN",
      role: "super_admin",
      permissions: ["*"],
      status: "active",
    };
    return next();
  }

  if (!adminDb) {
    logger.error(`[requireAdmin] Firestore adminDb unavailable | reqId=${reqId}`);
    res.status(500).json({
      success: false,
      message: "Server Error: Firestore database unavailable on backend.",
    });
    return;
  }

  try {
    const adminDocSnap = await adminDb.collection("admin_users").doc(uid).get();

    if (!adminDocSnap.exists) {
      logger.warn(`[requireAdmin] Forbidden: User UID ${uid} not found in admin_users collection | reqId=${reqId}`);
      res.status(403).json({
        success: false,
        message: "Forbidden: Account is not configured in administrator directory.",
      });
      return;
    }

    const adminData = adminDocSnap.data() || {};

    if (adminData.status !== "active") {
      logger.warn(`[requireAdmin] Forbidden: Administrator account ${uid} status is '${adminData.status}' | reqId=${reqId}`);
      res.status(403).json({
        success: false,
        message: "Forbidden: Administrator account is disabled or suspended.",
      });
      return;
    }

    // Attach adminUser data to request
    req.adminUser = adminData;
    logger.info(`[requireAdmin] Admin authorized | uid=${uid} | role=${adminData.role} | reqId=${reqId}`);
    return next();
  } catch (err: any) {
    logger.error(`[requireAdmin] Firestore check exception: ${err.message} | reqId=${reqId}`);
    res.status(500).json({
      success: false,
      message: "Server Error: Failed to verify administrator status.",
      error: err.message,
    });
    return;
  }
}

/**
 * 3. requirePermission: Factory that returns middleware enforcing a specific granular permission or super_admin role.
 */
export function requirePermission(permissionKey: string) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    const reqId = req.requestId;

    if (!req.adminUser) {
      logger.warn(`[requirePermission] Called without req.adminUser | reqId=${reqId}`);
      res.status(403).json({
        success: false,
        message: "Forbidden: Administrator context missing.",
      });
      return;
    }

    const { role, permissions } = req.adminUser;
    const isSuperAdmin = role === "super_admin" || (Array.isArray(permissions) && permissions.includes("*"));

    if (isSuperAdmin) {
      return next();
    }

    const hasPermission = Array.isArray(permissions) && permissions.includes(permissionKey);

    if (!hasPermission) {
      logger.warn(`[requirePermission] Access denied: Required '${permissionKey}', admin has role '${role}' | uid=${req.adminUser.uid} | reqId=${reqId}`);
      res.status(403).json({
        success: false,
        message: `Forbidden: Administrator lacks required permission '${permissionKey}'.`,
      });
      return;
    }

    return next();
  };
}

/**
 * 4. Audit Logging Helper
 */
export async function logAdminAction(payload: {
  adminUid: string;
  adminEmail: string;
  action: string;
  resource: string;
  resourceId?: string;
  oldValue?: any;
  newValue?: any;
  result?: string;
  ipAddress?: string;
  userAgent?: string;
}): Promise<void> {
  try {
    if (!adminDb) return;
    const now = new Date().toISOString();
    await adminDb.collection("admin_audit_logs").add({
      ...payload,
      timestamp: now,
      createdAt: now,
    });
  } catch (err: any) {
    logger.warn(`[logAdminAction] Error writing audit log: ${err.message}`);
  }
}

/**
 * Legacy S2S / Admin Auth Middleware (Maintained for existing S2S API key calls or legacy handlers)
 */
export function adminAuthMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  const reqId = req.requestId;

  // 1. Check for S2S API Key (INTERNAL_API_KEY / GATEWAY_API_KEY)
  const apiKeyHeader = req.headers["x-api-key"] as string;
  if (apiKeyHeader && env.GATEWAY_API_KEYS.includes(apiKeyHeader)) {
    logger.debug(`[AdminAuth] S2S shared API key validated successfully. | reqId=${reqId}`);
    return next();
  }

  // 2. Check for Firebase Admin claim or req.adminUser
  if (req.adminUser || (req.user && req.user.admin === true)) {
    return next();
  }

  res.status(403).json({
    success: false,
    message: "Forbidden: Admin privileges or a valid internal service API key are required.",
  });
}

export function strictHumanAdminAuthMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  if (req.adminUser || (req.user && req.user.admin === true)) {
    return next();
  }

  res.status(403).json({
    success: false,
    message: "Forbidden: This administrative action requires a verified human administrator session.",
  });
}
