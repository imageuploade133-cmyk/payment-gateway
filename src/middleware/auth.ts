import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env";
import logger from "../config/logger";

export interface AuthenticatedRequest extends Request {
  user?: any;
}

/**
 * Enterprise-grade gateway authentication middleware.
 * Supports API Key validation (with zero-downtime key rotation) and extensible JWT validation.
 */
export function gatewayAuthMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
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

  // 2. JWT Authentication path (Can be enabled/toggled)
  if (providedToken) {
    try {
      const decoded = jwt.verify(providedToken, env.JWT_SECRET);
      req.user = decoded;
      logger.info(`[Auth] JWT successfully verified | user=${(decoded as any).sub || "unknown"} | reqId=${reqId}`);
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
