import { Request, Response, NextFunction } from "express";
import logger from "../config/logger";

export const initializePayment = async (req: Request, res: Response, next: NextFunction) => {
  try {
    logger.info("[Paystack Controller] initializePayment stub called");
    res.status(501).json({
      success: false,
      message: "Paystack initialization is not implemented yet in this phase.",
    });
  } catch (error) {
    next(error);
  }
};

export const verifyPayment = async (req: Request, res: Response, next: NextFunction) => {
  try {
    logger.info("[Paystack Controller] verifyPayment stub called");
    res.status(501).json({
      success: false,
      message: "Paystack payment verification is not implemented yet in this phase.",
    });
  } catch (error) {
    next(error);
  }
};

export const handleWebhook = async (req: Request, res: Response, next: NextFunction) => {
  try {
    logger.info("[Paystack Controller] handleWebhook stub called");
    res.status(501).json({
      success: false,
      message: "Paystack webhook handling is not implemented yet in this phase.",
    });
  } catch (error) {
    next(error);
  }
};
