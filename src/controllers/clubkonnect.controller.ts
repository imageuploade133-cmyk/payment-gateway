import { Request, Response, NextFunction } from "express";
import logger from "../config/logger";
import { ClubkonnectService } from "../services/clubkonnect.service";
import { clubkonnectConfig } from "../config/clubkonnect";

/**
 * Controller to handle Clubkonnect wallet balance operations.
 * Performs validation of system configurations before executing the request.
 */
export const getWalletBalance = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const reqId = req.requestId;
  logger.info(`[Clubkonnect Controller] Received getWalletBalance request | reqId=${reqId}`);

  try {
    // Controller validation: ensure environment variables are correctly loaded
    if (!clubkonnectConfig.USER_ID) {
      logger.warn(`[Clubkonnect Controller] Validation failed: CLUBKONNECT_USER_ID is missing | reqId=${reqId}`);
      res.status(400).json({
        success: false,
        message: "Configuration Error: CLUBKONNECT_USER_ID is not configured on the gateway.",
      });
      return;
    }

    if (!clubkonnectConfig.API_KEY) {
      logger.warn(`[Clubkonnect Controller] Validation failed: CLUBKONNECT_API_KEY is missing | reqId=${reqId}`);
      res.status(400).json({
        success: false,
        message: "Configuration Error: CLUBKONNECT_API_KEY is not configured on the gateway.",
      });
      return;
    }

    // Call service to fetch wallet balance from provider
    const result = await ClubkonnectService.getWalletBalance(reqId);

    res.status(200).json(result);
  } catch (error: any) {
    logger.error(`[Clubkonnect Controller] getWalletBalance exception | error=${error.message} | reqId=${reqId}`);
    res.status(500).json({
      success: false,
      message: error.message || "An internal server error occurred while retrieving Clubkonnect wallet balance.",
    });
  }
};
