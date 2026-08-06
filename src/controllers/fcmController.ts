import { Response } from "express";
import { AuthenticatedRequest } from "../middleware/auth";
import adminDb from "../config/firebase";
import logger from "../config/logger";

export async function registerToken(req: AuthenticatedRequest, res: Response): Promise<void> {
  const reqId = req.requestId;
  const uid = req.user?.uid;

  if (!uid) {
    res.status(401).json({ success: false, message: "Unauthorized: Missing user identity." });
    return;
  }

  try {
    const { token, platform } = req.body;

    if (!token) {
      res.status(400).json({ success: false, message: "FCM token is required." });
      return;
    }

    if (!adminDb) {
      res.status(500).json({ success: false, message: "Database not initialized." });
      return;
    }

    const cleanToken = token.trim();
    const tokenDocId = `${uid}_${Buffer.from(cleanToken).toString("base64").slice(0, 100)}`;
    const tokenRef = adminDb.collection("fcm_tokens").doc(tokenDocId);

    const now = new Date().toISOString();

    await tokenRef.set({
      userId: uid,
      token: cleanToken,
      platform: platform || "web",
      createdAt: now,
      updatedAt: now,
    }, { merge: true });

    logger.info(`[FCM Backend API] Registered token for user ${uid} | reqId=${reqId}`);
    res.status(200).json({ success: true, message: "FCM Token registered successfully." });
  } catch (err: any) {
    logger.error(`[FCM Backend API Exception] Register failed: ${err.message} | reqId=${reqId}`);
    res.status(500).json({ success: false, message: "Internal processing error." });
  }
}

export async function unregisterToken(req: AuthenticatedRequest, res: Response): Promise<void> {
  const reqId = req.requestId;
  const uid = req.user?.uid;

  if (!uid) {
    res.status(401).json({ success: false, message: "Unauthorized: Missing user identity." });
    return;
  }

  try {
    const { token } = req.body;

    if (!token) {
      res.status(400).json({ success: false, message: "FCM token is required." });
      return;
    }

    if (!adminDb) {
      res.status(500).json({ success: false, message: "Database not initialized." });
      return;
    }

    const cleanToken = token.trim();
    const tokenDocId = `${uid}_${Buffer.from(cleanToken).toString("base64").slice(0, 100)}`;
    const tokenRef = adminDb.collection("fcm_tokens").doc(tokenDocId);

    await tokenRef.delete();

    logger.info(`[FCM Backend API] Unregistered token for user ${uid} | reqId=${reqId}`);
    res.status(200).json({ success: true, message: "FCM Token unregistered successfully." });
  } catch (err: any) {
    logger.error(`[FCM Backend API Exception] Unregister failed: ${err.message} | reqId=${reqId}`);
    res.status(500).json({ success: false, message: "Internal processing error." });
  }
}
