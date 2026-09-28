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

    // Resolve server-authoritative active session ID directly from Firestore users/{uid}
    let authoritativeSessionId: string | null = null;
    const providedSessionId = (req.headers["x-session-id"] as string) || req.body?.sessionId || "";

    try {
      const userDoc = await adminDb.collection("users").doc(uid).get();
      if (userDoc.exists) {
        authoritativeSessionId = userDoc.data()?.activeSessionId || null;
      }
    } catch (docErr: any) {
      logger.error(`[FCM Backend API Error] Failed to fetch active session for user ${uid}: ${docErr.message}`);
    }

    const sessionIdToStore = authoritativeSessionId || providedSessionId || null;

    const cleanToken = token.trim();
    const tokenDocId = `${uid}_${Buffer.from(cleanToken).toString("base64").slice(0, 100)}`;
    const tokenRef = adminDb.collection("fcm_tokens").doc(tokenDocId);

    const now = new Date().toISOString();

    await tokenRef.set({
      userId: uid,
      token: cleanToken,
      platform: platform || "web",
      ...(sessionIdToStore ? { sessionId: sessionIdToStore } : {}),
      createdAt: now,
      updatedAt: now,
    }, { merge: true });

    // Check for pending new device push notification marker
    const userRef = adminDb.collection("users").doc(uid);
    const userSnap = await userRef.get();
    const pendingSessionId = userSnap.exists ? userSnap.data()?.pendingNewDevicePushSessionId : null;
    if (pendingSessionId && (pendingSessionId === sessionIdToStore || !sessionIdToStore)) {
      try {
        const { getMessaging } = require("firebase-admin/messaging");
        await getMessaging().send({
          token: cleanToken,
          notification: {
            title: "New Device Login",
            body: "Your E-Global Pay account was successfully signed in on this device.",
          },
          data: {
            type: "security",
            event: "new_device_login",
          },
          android: { priority: "high", notification: { sound: "default" } },
          apns: { payload: { aps: { sound: "default" } } },
        });
        await userRef.update({ pendingNewDevicePushSessionId: null });
        logger.info(`[FCM Backend API] Successfully dispatched New Device Login push to token for user ${uid}`);
      } catch (pushErr: any) {
        logger.error(`[FCM Backend API] New-device push dispatch failed for user ${uid}: ${pushErr.message}`);
      }
    }

    logger.info(`[FCM Backend API] Registered token for user ${uid} (sessionId=${sessionIdToStore}) | reqId=${reqId}`);
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
