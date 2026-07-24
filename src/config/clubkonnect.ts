import dotenv from "dotenv";
import logger from "./logger";

dotenv.config();

export interface ClubkonnectConfig {
  BASE_URL: string;
  USER_ID: string;
  API_KEY: string;
}

function validateClubkonnectConfig(): ClubkonnectConfig {
  const BASE_URL = process.env.CLUBKONNECT_BASE_URL || "https://www.nellobytesystems.com";
  const USER_ID = process.env.CLUBKONNECT_USER_ID;
  const API_KEY = process.env.CLUBKONNECT_API_KEY;

  if (!USER_ID || !API_KEY) {
    logger.warn(`[Clubkonnect Config] Configuration Warning: Missing CLUBKONNECT_USER_ID or CLUBKONNECT_API_KEY in environment.`);
  }

  return {
    BASE_URL,
    USER_ID: USER_ID || "",
    API_KEY: API_KEY || "",
  };
}

export const clubkonnectConfig = validateClubkonnectConfig();
