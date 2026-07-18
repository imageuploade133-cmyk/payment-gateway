import { Request, Response, NextFunction } from "express";
import crypto from "crypto";

// Extend Express Request interface to include requestId
declare global {
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = req.headers["x-request-id"] as string || crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader("X-Request-ID", requestId);
  next();
}
