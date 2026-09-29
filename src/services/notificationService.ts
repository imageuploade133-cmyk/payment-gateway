import adminDb from "../config/firebase";
import { getMessaging } from "firebase-admin/messaging";
import logger from "../config/logger";

export type NotificationType = "transaction" | "security" | "promo";

export interface NotificationPayload {
  title: string;
  body: string;
  type: NotificationType;
  url?: string;
  amount?: number;
  currency?: string;
  reference?: string;
  recipientName?: string;
  bankName?: string;
  channel?: string;
}

export class NotificationService {
  /**
   * Sends a push notification strictly to active tokens matching the user's authoritative active session ID,
   * saves notification history, and returns the number of successfully delivered FCM pushes.
   * @param userId The ID of the recipient user.
   * @param payload The notification content.
   * @returns Object containing success count, total target tokens count, and notification history document ID.
   */
  public static async sendPushNotification(
    userId: string,
    payload: NotificationPayload
  ): Promise<{ successCount: number; totalTokens: number; notificationId?: string }> {
    const now = new Date().toISOString();
    let notificationId: string | undefined;

    // 1. Save to Firestore under user's notification subcollection
    if (adminDb) {
      try {
        const histDocId = payload.reference ? `tx-notif-${payload.reference}` : undefined;
        const notificationRef = histDocId
          ? adminDb.collection("users").doc(userId).collection("notifications").doc(histDocId)
          : adminDb.collection("users").doc(userId).collection("notifications").doc();

        await notificationRef.set({
          title: payload.title,
          body: payload.body,
          message: payload.body, // compatibility fallback
          type: payload.type,
          read: false,
          createdAt: now,
          url: payload.url || "",
          amount: payload.amount !== undefined ? payload.amount : null,
          currency: payload.currency || "NGN",
          reference: payload.reference || "",
          recipientName: payload.recipientName || "",
          bankName: payload.bankName || "",
          channel: payload.channel || "",
        }, { merge: true });
        notificationId = notificationRef.id;
        logger.info(`[NotificationService] Saved notification history for user=${userId} | docId=${notificationId}`);
      } catch (fsErr: any) {
        logger.error(`[NotificationService] Failed to save history for user=${userId} | error=${fsErr.message}`);
      }
    }

    if (!adminDb) {
      logger.warn(`[NotificationService] adminDb not initialized. Skipping FCM dispatch.`);
      return { successCount: 0, totalTokens: 0, notificationId };
    }

    // 2. Resolve authoritative active session ID and query FCM tokens ONLY for that active session
    const userSnapshot = await adminDb.collection("users").doc(userId).get();
    const activeSessionId = userSnapshot.exists
      ? String(userSnapshot.data()?.activeSessionId || "")
      : "";

    if (!activeSessionId) {
      logger.info(`[NotificationService] No active session for user=${userId}; skipping FCM dispatch.`);
      return { successCount: 0, totalTokens: 0, notificationId };
    }

    let tokensSnapshot = await adminDb.collection("fcm_tokens")
      .where("userId", "==", userId)
      .where("sessionId", "==", activeSessionId)
      .get();

    // Fallback: If no tokens carry sessionId yet, check tokens for user where sessionId is missing/empty
    if (tokensSnapshot.empty) {
      const fallbackSnap = await adminDb.collection("fcm_tokens")
        .where("userId", "==", userId)
        .get();

      const validFallbackDocs = fallbackSnap.docs.filter(docSnap => {
        const d = docSnap.data();
        return !d.sessionId || d.sessionId === activeSessionId;
      });

      if (validFallbackDocs.length === 0) {
        logger.info(`[NotificationService] No active FCM tokens registered for user=${userId} with activeSessionId=${activeSessionId}`);
        return { successCount: 0, totalTokens: 0, notificationId };
      }

      tokensSnapshot = {
        empty: false,
        forEach: (callback: (doc: any) => void) => validFallbackDocs.forEach(callback),
      } as any;
    }

    const tokensList: { id: string; token: string; platform: string }[] = [];
    tokensSnapshot.forEach((docSnap) => {
      const data = docSnap.data();
      if (data.token) {
        tokensList.push({
          id: docSnap.id,
          token: data.token,
          platform: data.platform || "web",
        });

        // Auto-fix missing sessionId on document if activeSessionId is known
        if (activeSessionId && !data.sessionId && docSnap.ref && typeof docSnap.ref.update === "function") {
          docSnap.ref.update({ sessionId: activeSessionId }).catch(() => {});
        }
      }
    });

    logger.info(`[NotificationService] Found ${tokensList.length} FCM token(s) matching activeSessionId=${activeSessionId} for user=${userId}`);

    // 3. Send notifications via FCM with explicit channelId and APNs alert payload
    const messaging = getMessaging();
    const tokensToDelete: string[] = [];
    let successCount = 0;

    for (const t of tokensList) {
      try {
        const message = {
          token: t.token,
          notification: {
            title: payload.title,
            body: payload.body,
          },
          data: {
            title: payload.title,
            body: payload.body,
            type: payload.type,
            url: payload.reference ? `/?txRef=${payload.reference}` : (payload.url || ""),
            click_action: payload.reference ? `/?txRef=${payload.reference}` : (payload.url || ""),
            reference: payload.reference || "",
            transactionReference: payload.reference || "",
            txRef: payload.reference || "",
          },
          android: {
            priority: "high" as const,
            notification: {
              sound: "default",
              channelId: "eglobal_wallet_high_channel",
              clickAction: "FLUTTER_NOTIFICATION_CLICK",
            },
          },
          apns: {
            payload: {
              aps: {
                alert: {
                  title: payload.title,
                  body: payload.body,
                },
                sound: "default",
                badge: 1,
              },
            },
          },
          webpush: {
            headers: {
              Urgency: "high",
            },
            notification: {
              icon: "https://i.ibb.co/WWjZrtC7/E-Tech.png",
              badge: "https://i.ibb.co/WWjZrtC7/E-Tech.png",
            },
          },
        };

        const fcmResponse = await messaging.send(message);
        successCount++;
        logger.info(`[NotificationService] Push successfully dispatched to platform=${t.platform} | fcmId=${fcmResponse}`);
      } catch (fcmErr: any) {
        const errMsg = fcmErr.message || "";
        logger.warn(`[NotificationService] Failed to send push to token=${t.id} | error=${errMsg}`);

        const isInvalidToken =
          fcmErr.code === "messaging/invalid-registration-token" ||
          fcmErr.code === "messaging/registration-token-not-registered" ||
          errMsg.includes("registration-token-not-registered") ||
          errMsg.includes("invalid-registration-token") ||
          errMsg.includes("InvalidRegistration") ||
          errMsg.includes("NotRegistered");

        if (isInvalidToken) {
          tokensToDelete.push(t.id);
        }
      }
    }

    // Clean up invalid tokens asynchronously
    if (tokensToDelete.length > 0 && adminDb) {
      const db = adminDb;
      const batch = db.batch();
      tokensToDelete.forEach((tokenId) => {
        batch.delete(db.collection("fcm_tokens").doc(tokenId));
      });
      await batch.commit().catch((bErr) => logger.error(`[NotificationService] Token cleanup error: ${bErr.message}`));
      logger.info(`[NotificationService] Automatically deleted ${tokensToDelete.length} invalid/expired FCM token(s).`);
    }

    return {
      successCount,
      totalTokens: tokensList.length,
      notificationId,
    };
  }
}
