import { getApps, initializeApp, cert, App } from "firebase-admin/app";
import { getFirestore, Firestore } from "firebase-admin/firestore";
import logger from "./logger";

let adminApp: App | null = null;
let internalAdminDb: Firestore | null = null;
let hasAdminCredentials = false;

export function initializeFirebaseAdmin(): { app: App | null; db: Firestore | null; hasCredentials: boolean } {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (privateKey) {
    // Correctly restore newline escaping in private keys
    privateKey = privateKey.replace(/\\n/g, "\n");
  }

  function getCredentials() {
    if (serviceAccountJson) {
      try {
        const parsed = JSON.parse(serviceAccountJson);
        return cert(parsed);
      } catch (e: any) {
        logger.error(`[Firebase] Error parsing FIREBASE_SERVICE_ACCOUNT_KEY JSON string: ${e.message}`);
      }
    }

    if (projectId && clientEmail && privateKey) {
      return cert({
        projectId,
        clientEmail,
        privateKey,
      });
    }

    return undefined;
  }

  try {
    const apps = getApps();
    if (apps.length > 0) {
      adminApp = apps[0];
      internalAdminDb = getFirestore(adminApp);
      hasAdminCredentials = true;
      logger.info("[Firebase] Reusing existing Firebase Admin instance.");
    } else {
      const credential = getCredentials();
      const fallbackProjectId = projectId || "e-tech-global-hub";

      if (credential) {
        adminApp = initializeApp({
          credential,
          projectId: fallbackProjectId,
        });
        internalAdminDb = getFirestore(adminApp);
        hasAdminCredentials = true;
        logger.info(`[Firebase] Initialized Firebase Admin SDK for project: ${fallbackProjectId}`);
      } else {
        logger.warn(
          "[Firebase Warning] Missing Firebase Admin credentials. Firestore database-backed features will run in Mock/Memory Fallback mode."
        );
      }
    }
  } catch (error: any) {
    logger.error(`[Firebase Exception] Initialization crash: ${error.message}. Continuing in high-availability mock mode.`);
  }

  return {
    app: adminApp,
    db: internalAdminDb,
    hasCredentials: hasAdminCredentials,
  };
}

export const firebase = initializeFirebaseAdmin();
export const adminDb = firebase.db;
export const hasAdminCredentialsActive = firebase.hasCredentials;
export default adminDb;
