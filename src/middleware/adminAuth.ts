import { Response, NextFunction } from "express";
import { AuthenticatedRequest } from "./auth";
import { env } from "../config/env";
import logger from "../config/logger";

/**
 * Middleware to restrict access to administrators and trusted S2S internal services only.
 * Requires either a valid shared API key (S2S) OR a verified user token containing the `{ admin: true }` custom claim.
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

  // 2. Check for Firebase Admin claim (admin == true)
  if (req.user && req.user.admin === true) {
    logger.info(`[AdminAuth] Admin privilege verified via Firebase Auth custom claims. User: ${req.user.uid} | reqId=${reqId}`);
    return next();
  }

  // Reject with Forbidden
  const maskedKey = apiKeyHeader && apiKeyHeader.length > 6
    ? `${apiKeyHeader.slice(0, 3)}...${apiKeyHeader.slice(-3)}`
    : "***";

  logger.warn(
    `[AdminAuth] Access denied to admin-only endpoint | user=${req.user?.uid || "anonymous"} | maskedKey=${maskedKey} | reqId=${reqId}`
  );

  res.status(403).json({
    success: false,
    message: "Forbidden: Admin privileges or a valid internal service API key are required to access this endpoint.",
  });
}
