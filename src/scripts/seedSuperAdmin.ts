import { firebase, adminDb } from "../config/firebase";

const SUPER_ADMIN_EMAIL = "abdulkadir123shaba@gmail.com";

async function seedSuperAdmin() {
  console.log(`[Backend Seed Super Admin] Provisioning Super Admin for ${SUPER_ADMIN_EMAIL}...`);

  if (!firebase.app || !adminDb) {
    console.error("[Backend Seed Super Admin] Firebase Admin SDK app not initialized.");
    process.exit(1);
  }

  const { getAuth } = require("firebase-admin/auth");
  const auth = getAuth(firebase.app);

  let userRecord;
  try {
    userRecord = await auth.getUserByEmail(SUPER_ADMIN_EMAIL);
    console.log(`[Backend Seed Super Admin] Found Firebase Auth user UID: ${userRecord.uid}`);
  } catch (err: any) {
    console.error(`[Backend Seed Super Admin] User not found in Firebase Auth: ${err.message}`);
    process.exit(1);
  }

  const uid = userRecord.uid;
  const now = new Date().toISOString();

  const superAdminData = {
    uid,
    email: SUPER_ADMIN_EMAIL,
    displayName: userRecord.displayName || "ABDULKADIR SHABA",
    role: "super_admin",
    permissions: ["*"],
    status: "active",
    createdBy: "seed_script",
    createdAt: now,
    updatedAt: now,
    lastLoginAt: now,
    mfaEnabled: false,
  };

  await adminDb.collection("admin_users").doc(uid).set(superAdminData, { merge: true });

  try {
    await auth.setCustomUserClaims(uid, {
      admin: true,
      role: "super_admin",
    });
    console.log(`[Backend Seed Super Admin] Custom claims applied for UID: ${uid}`);
  } catch (claimErr: any) {
    console.warn(`[Backend Seed Super Admin] Claim error: ${claimErr.message}`);
  }

  console.log(`✅ [Backend Seed Super Admin] Super Admin successfully provisioned in admin_users/${uid}!`);
  process.exit(0);
}

seedSuperAdmin().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
