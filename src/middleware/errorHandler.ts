import { Request, Response, NextFunction } from "express";
import logger from "../config/logger";

export interface AppError extends Error {
  statusCode?: number;
}

export function errorHandler(
  err: AppError,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const statusCode = err.statusCode || 500;
  const message = err.message || "Internal Server Error";

  logger.error(`[ErrorHandler] Error: ${message} | Route: ${req.method} ${req.url} | Status: ${statusCode}`);
  if (err.stack && process.env.NODE_ENV === "development") {
    logger.debug(err.stack);
  }

  res.status(statusCode).json({
    success: false,
    error: message,
    ...(process.env.NODE_ENV === "development" && { stack: err.stack }),
  });
}
