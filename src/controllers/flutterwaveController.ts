import { Request, Response, NextFunction } from "express";
import logger from "../config/logger";

export const resolveAccount = async (req: Request, res: Response, next: NextFunction) => {
  try {
    logger.info("[Flutterwave Controller] resolveAccount stub called");
    res.status(501).json({
      success: false,
      message: "Account resolution is not implemented yet in this phase.",
    });
  } catch (error) {
    next(error);
  }
};

export const initiateTransfer = async (req: Request, res: Response, next: NextFunction) => {
  try {
    logger.info("[Flutterwave Controller] initiateTransfer stub called");
    res.status(501).json({
      success: false,
      message: "Single transfer is not implemented yet in this phase.",
    });
  } catch (error) {
    next(error);
  }
};

export const initiateBulkTransfer = async (req: Request, res: Response, next: NextFunction) => {
  try {
    logger.info("[Flutterwave Controller] initiateBulkTransfer stub called");
    res.status(501).json({
      success: false,
      message: "Bulk transfer is not implemented yet in this phase.",
    });
  } catch (error) {
    next(error);
  }
};

export const createVirtualAccount = async (req: Request, res: Response, next: NextFunction) => {
  try {
    logger.info("[Flutterwave Controller] createVirtualAccount stub called");
    res.status(501).json({
      success: false,
      message: "Virtual account creation is not implemented yet in this phase.",
    });
  } catch (error) {
    next(error);
  }
};

export const verifyPayment = async (req: Request, res: Response, next: NextFunction) => {
  try {
    logger.info("[Flutterwave Controller] verifyPayment stub called");
    res.status(501).json({
      success: false,
      message: "Payment verification is not implemented yet in this phase.",
    });
  } catch (error) {
    next(error);
  }
};

export const handleWebhook = async (req: Request, res: Response, next: NextFunction) => {
  try {
    logger.info("[Flutterwave Controller] handleWebhook stub called");
    res.status(501).json({
      success: false,
      message: "Webhook verification is not implemented yet in this phase.",
    });
  } catch (error) {
    next(error);
  }
};
