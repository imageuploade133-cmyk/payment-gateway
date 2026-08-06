import adminDb from "../config/firebase";
import { getMessaging } from "firebase-admin/messaging";
import logger from "../config/logger";

export type NotificationType = "transaction" | "security" | "promo";

export interface NotificationPayload {
  title: string;
  body: string;
  type: NotificationType;
  url?: string;
}

export class NotificationService {
  /**
   * Sends a push notification to all registered tokens for a user and saves the notification in history.
   * @param userId The ID of the recipient user.
   * @param payload The notification content (title, body, type, url).
   */
  public static async sendPushNotification(userId: string, payload: NotificationPayload): Promise<void> {
    try {
      const now = new Date().toISOString();

      // 1. Save to Firestore under user's notification subcollection
      if (adminDb) {
        try {
          const notificationRef = adminDb.collection("users").doc(userId).collection("notifications").doc();
          await notificationRef.set({
            title: payload.title,
            body: payload.body,
            message: payload.body, // compatibility fallback
            type: payload.type,
            read: false,
            createdAt: now,
            url: payload.url || "",
          });
          logger.info(`[NotificationService] Saved notification history for user=${userId} | docId=${notificationRef.id}`);
        } catch (fsErr: any) {
          logger.error(`[NotificationService] Failed to save history for user=${userId} | error=${fsErr.message}`);
        }
      }

      // 2. Fetch all registered tokens for this user
      if (!adminDb) {
        logger.warn(`[NotificationService] adminDb not initialized. Skipping FCM dispatch.`);
        return;
      }

      const tokensSnapshot = await adminDb.collection("fcm_tokens").where("userId", "==", userId).get();
      if (tokensSnapshot.empty) {
        logger.info(`[NotificationService] No active FCM tokens registered for user=${userId}`);
        return;
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
        }
      });

      logger.info(`[NotificationService] Found ${tokensList.length} FCM token(s) for user=${userId}`);

      // 3. Send notifications via FCM
      const messaging = getMessaging();
      const tokensToDelete: string[] = [];

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
              url: payload.url || "",
              click_action: payload.url || "",
            },
            android: {
              priority: "high" as const,
              notification: {
                sound: "default",
                clickAction: "FLUTTER_NOTIFICATION_CLICK",
              },
            },
            apns: {
              payload: {
                aps: {
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
          logger.info(`[NotificationService] Push successfully dispatched to platform=${t.platform} | fcmId=${fcmResponse}`);
        } catch (fcmErr: any) {
          const errMsg = fcmErr.message || "";
          logger.warn(`[NotificationService] Failed to send push to token=${t.id} | error=${errMsg}`);

          // Automatic Invalid/Expired Token Cleanup
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

      // Perform cleanups asynchronously to avoid blocking
      if (tokensToDelete.length > 0 && adminDb) {
        const db = adminDb;
        const batch = db.batch();
        tokensToDelete.forEach((tokenId) => {
          batch.delete(db.collection("fcm_tokens").doc(tokenId));
        });
        await batch.commit();
        logger.info(`[NotificationService] Automatically deleted ${tokensToDelete.length} invalid/expired FCM token(s).`);
      }

    } catch (err: any) {
      logger.error(`[NotificationService Exception] Failed to execute notification dispatch: ${err.message}`);
    }
  }
}
