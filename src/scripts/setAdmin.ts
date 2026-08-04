import "dotenv/config";
import { getAuth } from "firebase-admin/auth";
import { firebase, initializeFirebaseAdmin } from "../config/firebase";
import logger from "../config/logger";

/**
 * Standard administrative script to grant or revoke admin custom claims.
 * Usage:
 *   npx ts-node src/scripts/setAdmin.ts --email admin@etechglobal.org --grant
 *   npx ts-node src/scripts/setAdmin.ts --uid UID_HERE --revoke
 */
async function run() {
  const args = process.argv.slice(2);

  let email = "";
  let uid = "";
  let grant = false;
  let revoke = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--email" && args[i + 1]) {
      email = args[i + 1].trim();
      i++;
    } else if (args[i] === "--uid" && args[i + 1]) {
      uid = args[i + 1].trim();
      i++;
    } else if (args[i] === "--grant") {
      grant = true;
    } else if (args[i] === "--revoke") {
      revoke = true;
    }
  }

  if (!email && !uid) {
    console.error("Error: Please specify either --email <email> or --uid <uid>");
    process.exit(1);
  }

  if (grant && revoke) {
    console.error("Error: Please specify either --grant or --revoke, not both.");
    process.exit(1);
  }

  if (!grant && !revoke) {
    console.error("Error: Please specify either --grant or --revoke");
    process.exit(1);
  }

  // Force initialization of firebase
  const fbApp = firebase.app;
  const db = firebase.db;

  if (!fbApp || !db) {
    console.error("Error: Firebase Admin is not initialized. Please ensure environment variables are loaded.");
    process.exit(1);
  }

  const auth = getAuth(fbApp);

  try {
    let user;
    if (email) {
      logger.info(`[AdminCLI] Looking up user by email: ${email}`);
      user = await auth.getUserByEmail(email);
    } else {
      logger.info(`[AdminCLI] Looking up user by UID: ${uid}`);
      user = await auth.getUser(uid);
    }

    const userId = user.uid;
    const currentClaims = user.customClaims || {};

    if (grant) {
      logger.info(`[AdminCLI] Granting admin custom claims to user: ${user.email} (UID: ${userId})`);
      await auth.setCustomUserClaims(userId, { ...currentClaims, admin: true });
      
      logger.info(`[AdminCLI] Synchronously mirroring role field inside Firestore collection 'users'...`);
      await db.collection("users").doc(userId).set({
        role: "admin",
        updatedAt: new Date().toISOString(),
      }, { merge: true });

      logger.info(`[AdminCLI] SUCCESS: Administrative custom claims successfully granted to ${user.email}`);
    } else {
      logger.info(`[AdminCLI] Revoking admin custom claims from user: ${user.email} (UID: ${userId})`);
      const nextClaims = { ...currentClaims };
      delete nextClaims.admin;
      await auth.setCustomUserClaims(userId, nextClaims);

      logger.info(`[AdminCLI] Synchronously mirroring role field inside Firestore collection 'users'...`);
      await db.collection("users").doc(userId).set({
        role: "user",
        updatedAt: new Date().toISOString(),
      }, { merge: true });

      logger.info(`[AdminCLI] SUCCESS: Administrative custom claims successfully revoked from ${user.email}`);
    }
    process.exit(0);
  } catch (err: any) {
    logger.error(`[AdminCLI] Operational failure: ${err.message}`);
    process.exit(1);
  }
}

run();
