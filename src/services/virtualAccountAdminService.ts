import crypto from "crypto";
import adminDb from "../config/firebase";
import { PaymentVerificationService } from "./paymentVerificationService";
import { logAdminAction } from "../middleware/adminAuth";

function mask(value?: string | null): string | null {
  if (!value) return null;
  const s = String(value);
  return s.length <= 4 ? s : `****${s.slice(-4)}`;
}

export class VirtualAccountAdminService {
  static async replaceAccount(userId: string, adminUid: string, adminEmail: string, requestId: string): Promise<any> {
    if (!adminDb) throw new Error("Firestore database is not configured.");

    const userRef = adminDb.collection("users").doc(userId);
    const accountRef = adminDb.collection("wallet_accounts").doc(userId);
    const lockRef = adminDb.collection("virtual_account_operations").doc(`lock-${userId}`);
    const userSnap = await userRef.get();
    if (!userSnap.exists) throw new Error("User profile not found.");

    const user = userSnap.data() || {};
    if (String(user.kycStatus || "").toUpperCase() !== "VERIFIED") {
      throw new Error("Virtual account replacement requires VERIFIED KYC.");
    }

    const identityType = String(user.kycDocumentType || "").toLowerCase();
    const identity = identityType === "nin" ? String(user.nin || "").trim() : String(user.bvn || "").trim();
    if (!/^[0-9]{11}$/.test(identity)) {
      throw new Error("The user's existing verified NIN/BVN is missing or invalid.");
    }
    if (identityType !== "nin" && identityType !== "bvn") {
      throw new Error("The verified KYC identity type is missing.");
    }

    const operationId = crypto.randomUUID();
    const operationRef = adminDb.collection("virtual_account_operations").doc(operationId);
    const now = new Date().toISOString();

    await adminDb.runTransaction(async t => {
      const lockSnap = await t.get(lockRef);
      const current = lockSnap.exists ? lockSnap.data() || {} : {};
      const expiresAt = Number(current.expiresAt || 0);
      if (current.status === "RUNNING" && expiresAt > Date.now()) {
        throw new Error("Another virtual-account replacement is already processing for this user.");
      }
      t.set(lockRef, { status: "RUNNING", operationId, adminUid, expiresAt: Date.now() + 5 * 60 * 1000, updatedAt: now }, { merge: true });
      t.set(operationRef, {
        operationId, userId, adminUid, adminEmail, type: "REPLACE",
        status: "STARTED", createdAt: now, requestId,
        identityType, identityHash: crypto.createHash("sha256").update(identity).digest("hex"),
      });
    });

    const releaseLock = async (status: string) => {
      await lockRef.set({ status, operationId, expiresAt: 0, updatedAt: new Date().toISOString() }, { merge: true });
    };

    let oldOrderRef = "";
    let newOrderRef = "";
    try {
      const currentSnap = await accountRef.get();
      const current = currentSnap.exists ? currentSnap.data() || {} : null;
      if (!current?.accountNumber) throw new Error("No existing virtual account was found for this user.");

      const oldAccount = {
        accountNumber: String(current.accountNumber),
        bankName: current.bankName || "",
        accountName: current.accountName || "",
        currency: current.currency || "NGN",
        provider: current.provider || "flutterwave",
        txRef: current.txRef || current.reference || "",
        flwRef: current.flwRef || "",
      };

      if (oldAccount.provider !== "flutterwave") {
        throw new Error("This replacement operation currently supports Flutterwave virtual accounts only.");
      }

      // Resolve the provider's order_ref before deactivation. The old account is never
      // made inactive in E-Global until Flutterwave accepts the deactivation.
      let oldProvider: any = null;
      if (oldAccount.txRef) {
        oldProvider = await PaymentVerificationService.getVirtualAccountByRef(oldAccount.txRef, `va-replace-${operationId}`);
      }
      oldOrderRef = oldProvider?.order_ref || current.orderRef;
      if (!oldOrderRef) {
        throw new Error("The existing Flutterwave account reference could not be resolved safely; replacement was stopped.");
      }

      const deactivate = await PaymentVerificationService.setVirtualAccountStatus(oldOrderRef, "inactive", `va-replace-${operationId}`);
      if (!deactivate.success) {
        throw new Error(deactivate.message || "Flutterwave did not deactivate the existing account.");
      }

      const firstName = String(user.firstName || user.name || "").trim().split(/\s+/)[0] || "";
      const lastName = String(user.lastName || user.name || "").trim().split(/\s+/).slice(1).join(" ") || firstName;
      const email = String(user.email || "").trim();
      const phone = String(user.phoneNumber || user.phone || "").trim();
      if (!firstName || !lastName || !email || !phone) {
        await PaymentVerificationService.setVirtualAccountStatus(oldOrderRef, "active", `va-replace-rollback-${operationId}`);
        throw new Error("Verified user profile is missing required account-provisioning details.");
      }

      const newTxRef = `va-replace-${userId}-${operationId}`;
      const created = await PaymentVerificationService.createVirtualAccount({
        email, is_permanent: true, bvn: identityType === "bvn" ? identity : "",
        nin: identityType === "nin" ? identity : "",
        tx_ref: newTxRef, phonenumber: phone, firstname: firstName, lastname: lastName,
        requestId: `va-replace-${operationId}`, idempotencyKey: newTxRef,
      });

      if (!created.success || !created.account_number) {
        // Restore the old provider account if creation failed.
        await PaymentVerificationService.setVirtualAccountStatus(oldOrderRef, "active", `va-replace-rollback-${operationId}`);
        throw new Error(created.message || "Flutterwave failed to generate the replacement account.");
      }

      newOrderRef = created.order_ref || "";
      const createdAt = new Date().toISOString();
      const historyRef = adminDb.collection("wallet_account_history").doc();
      await adminDb.runTransaction(async t => {
        const freshAccount = await t.get(accountRef);
        const fresh = freshAccount.exists ? freshAccount.data() || {} : {};
        if (fresh.accountNumber !== oldAccount.accountNumber || fresh.status !== "active") {
          throw new Error("The existing account changed while replacement was processing. No database switch was performed.");
        }

        t.set(historyRef, {
          userId,
          accountNumber: oldAccount.accountNumber,
          bankName: oldAccount.bankName,
          accountName: oldAccount.accountName,
          currency: oldAccount.currency,
          provider: oldAccount.provider,
          txRef: oldAccount.txRef,
          flwRef: oldAccount.flwRef,
          orderRef: oldOrderRef,
          status: "REPLACED",
          createdAt: current.createdAt || createdAt,
          replacedAt: createdAt,
          replacedByTxRef: newTxRef,
          replacedByAccountNumber: created.account_number,
          replacementOperationId: operationId,
          replacedByAdminUid: adminUid,
        });

        t.set(accountRef, {
          userId,
          accountNumber: created.account_number,
          bankName: created.bank_name,
          accountName: created.account_name,
          currency: created.currency || "NGN",
          provider: "flutterwave",
          isPermanent: true,
          status: "active",
          txRef: newTxRef,
          flwRef: created.flwRef || "",
          orderRef: created.order_ref || "",
          identityType,
          updatedAt: createdAt,
          createdAt,
          previousAccountNumber: oldAccount.accountNumber,
          previousAccountHistoryId: historyRef.id,
        }, { merge: true });

        t.set(operationRef, {
          status: "SUCCESS",
          completedAt: createdAt,
          oldAccountMasked: mask(oldAccount.accountNumber),
          newAccountMasked: mask(created.account_number),
          providerReference: created.flwRef || newTxRef,
        }, { merge: true });
      });

      await logAdminAction({
        adminUid, adminEmail,
        action: "VIRTUAL_ACCOUNT_REPLACED",
        resource: "wallet_accounts",
        resourceId: userId,
        oldValue: { accountNumber: mask(oldAccount.accountNumber), provider: oldAccount.provider },
        newValue: { accountNumber: mask(created.account_number), provider: "flutterwave", identityType },
        result: "SUCCESS",
        ipAddress: "server",
        userAgent: "cpanel",
      });

      await releaseLock("COMPLETED");
      return {
        success: true,
        operationId,
        oldAccount: { accountNumber: mask(oldAccount.accountNumber), bankName: oldAccount.bankName, status: "REPLACED" },
        account: {
          accountNumber: created.account_number,
          bankName: created.bank_name,
          accountName: created.account_name,
          currency: created.currency || "NGN",
          status: "active",
        },
      };
    } catch (error: any) {
      // Best-effort provider rollback: never leave the old account disabled when replacement failed.
      try {
        if (newOrderRef) await PaymentVerificationService.setVirtualAccountStatus(newOrderRef, "inactive", `va-replace-rollback-new-${operationId}`);
      } catch {}
      try {
        if (oldOrderRef) await PaymentVerificationService.setVirtualAccountStatus(oldOrderRef, "active", `va-replace-rollback-old-${operationId}`);
      } catch {}
      await operationRef.set({ status: "FAILED", completedAt: new Date().toISOString(), error: error.message }, { merge: true }).catch(() => {});
      await releaseLock("FAILED").catch(() => {});
      await logAdminAction({
        adminUid, adminEmail,
        action: "VIRTUAL_ACCOUNT_REPLACEMENT_FAILED",
        resource: "wallet_accounts",
        resourceId: userId,
        result: "FAILED",
        ipAddress: "server",
        userAgent: "cpanel",
      });
      throw error;
    }
  }

  static async getUserAccount(userId: string): Promise<any> {
    if (!adminDb) throw new Error("Firestore database is not configured.");
    const [userSnap, accountSnap, historySnap] = await Promise.all([
      adminDb.collection("users").doc(userId).get(),
      adminDb.collection("wallet_accounts").doc(userId).get(),
      adminDb.collection("wallet_account_history").where("userId", "==", userId).limit(50).get(),
    ]);
    if (!userSnap.exists) throw new Error("User profile not found.");
    const u = userSnap.data() || {};
    const a = accountSnap.exists ? accountSnap.data() || {} : null;
    return {
      uid: userId,
      name: u.name || `${u.firstName || ""} ${u.lastName || ""}`.trim(),
      firstName: u.firstName || "",
      lastName: u.lastName || "",
      email: u.email || "",
      phoneNumber: u.phoneNumber || u.phone || "",
      kycStatus: u.kycStatus || "UNVERIFIED",
      kycDocumentType: u.kycDocumentType || null,
      bvn: mask(u.bvn),
      nin: mask(u.nin),
      identityPresent: !!(u.bvn || u.nin),
      account: a ? {
        accountNumber: mask(a.accountNumber),
        accountName: a.accountName || "",
        bankName: a.bankName || "",
        currency: a.currency || "NGN",
        status: a.status || "unknown",
        provider: a.provider || "flutterwave",
        createdAt: a.createdAt || null,
        updatedAt: a.updatedAt || null,
      } : null,
      history: historySnap.docs.map(d => {
        const h = d.data();
        return {
          id: d.id, accountNumber: mask(h.accountNumber), bankName: h.bankName || "",
          accountName: h.accountName || "", status: h.status || "REPLACED",
          provider: h.provider || "", createdAt: h.createdAt || null, replacedAt: h.replacedAt || null,
        };
      }).sort((x, y) => String(y.replacedAt || y.createdAt).localeCompare(String(x.replacedAt || x.createdAt))),
    };
  }

  static async searchUsers(q: string): Promise<any[]> {
    if (!adminDb) throw new Error("Firestore database is not configured.");
    const term = q.trim();
    if (term.length < 2 || term.length > 100) throw new Error("Search must contain between 2 and 100 characters.");

    const refs: FirebaseFirestore.DocumentSnapshot[] = [];
    const seen = new Set<string>();
    const add = (snap: FirebaseFirestore.QuerySnapshot) => snap.docs.forEach(d => { if (!seen.has(d.id)) { seen.add(d.id); refs.push(d); } });

    // UID is a document identifier, so resolve it directly without a collection scan.
    if (/^[A-Za-z0-9_-]{6,128}$/.test(term)) {
      const uidSnap = await adminDb.collection("users").doc(term).get();
      if (uidSnap.exists) refs.push(uidSnap);
    }

    const normalizedEmail = term.toLowerCase();
    const queries = [
      adminDb.collection("users").where("email", "==", normalizedEmail).limit(10).get(),
      adminDb.collection("users").where("email", "==", term).limit(10).get(),
      adminDb.collection("users").where("phoneNumber", "==", term).limit(10).get(),
      adminDb.collection("users").where("phone", "==", term).limit(10).get(),
      adminDb.collection("users").where("bvn", "==", term).limit(10).get(),
      adminDb.collection("users").where("nin", "==", term).limit(10).get(),
      adminDb.collection("users").where("name", "==", term).limit(10).get(),
    ];
    const results = await Promise.all(queries);
    results.forEach(add);

    if (refs.length === 0) {
      const [first, last] = term.split(/\s+/, 2);
      if (first) add(await adminDb.collection("users").where("firstName", "==", first).limit(10).get());
      if (last) add(await adminDb.collection("users").where("lastName", "==", last).limit(10).get());
    }

    return refs.slice(0, 25).map(d => {
      const u = d.data() || {};
      return {
        uid: d.id,
        name: u.name || `${u.firstName || ""} ${u.lastName || ""}`.trim() || "Unnamed User",
        email: u.email || "",
        phoneNumber: u.phoneNumber || u.phone || "",
        kycStatus: u.kycStatus || "UNVERIFIED",
        kycDocumentType: u.kycDocumentType || null,
        bvn: mask(u.bvn),
        nin: mask(u.nin),
      };
    });
  }
}
