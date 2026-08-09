import crypto from "crypto";
import adminDb from "../config/firebase";
import logger from "../config/logger";
import { PaymentVerificationService } from "./paymentVerificationService";
import { SquadService } from "./squadService";
import { KycStatus, KycSubmission } from "../types/kyc";

export interface KycVerificationRequest {
  userId: string;
  firstName: string;
  lastName: string;
  documentType: "bvn" | "nin";
  documentNumber: string;
  email: string;
  phone: string;
  capturedSelfie?: string; // base64 string
  livenessChallenge?: string;
}

export class KycService {
  /**
   * Hashes the BVN or NIN using SHA-256 for duplicate checking
   */
  public static hashIdentityNumber(idNumber: string): string {
    return crypto.createHash("sha256").update(idNumber.trim()).digest("hex");
  }

  /**
   * Fuzzy word-matching to verify legal names overlap with verified identity records
   */
  public static fuzzyNameMatch(registeredName: string, providerName: string): boolean {
    const norm1 = registeredName.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean);
    const norm2 = providerName.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean);

    let matchCount = 0;
    norm1.forEach((word) => {
      if (norm2.includes(word)) {
        matchCount++;
      }
    });

    // Accept match if there is at least one overlapping name token
    return matchCount > 0;
  }

  /**
   * Submits a user KYC request securely to Firestore collection `kyc_submissions` as PENDING.
   * Does NOT perform auto-approvals, does NOT provision bank accounts.
   */
  public static async submitKyc(req: KycVerificationRequest): Promise<any> {
    const {
      userId,
      firstName,
      lastName,
      documentType,
      documentNumber,
      email,
      phone,
      capturedSelfie,
      livenessChallenge,
    } = req;

    if (!adminDb) {
      throw new Error("Firestore Admin Database is not initialized.");
    }

    const cleanNum = documentNumber.trim();
    if (!/^\d{11}$/.test(cleanNum)) {
      throw new Error("Identity document number must be exactly 11 digits.");
    }

    const hashedId = this.hashIdentityNumber(cleanNum);
    logger.info(`[KycService] Starting KYC submission for user: ${userId} | HashedDoc: ${hashedId}`);

    // Check duplicate BVN/NIN before submitting
    const hashDocRef = adminDb.collection("kyc_hashes").doc(hashedId);
    const hashSnap = await hashDocRef.get();
    if (hashSnap.exists) {
      const hashData = hashSnap.data();
      if (hashData && hashData.userId !== userId) {
        logger.warn(`[KycService] Duplicate check failure. BVN/NIN already mapped to another user.`);
        throw new Error("This BVN or NIN is already verified on another account. Please use your registered account.");
      }
    }

    // Save PENDING submission
    const submissionRef = adminDb.collection("kyc_submissions").doc(userId);
    const newSubmission: KycSubmission = {
      userId,
      firstName,
      lastName,
      email,
      phone,
      documentType,
      documentNumber: cleanNum, // Plain stored securely in backend kyc_submissions only, visible only to verified human admin
      capturedSelfie,
      livenessChallenge,
      status: "PENDING",
      submittedAt: new Date().toISOString(),
    };

    await submissionRef.set(newSubmission, { merge: true });

    // Update user profile status to PENDING
    const userDocRef = adminDb.collection("users").doc(userId);
    await userDocRef.set({
      kycStatus: "PENDING",
      kycDocumentType: documentType,
      updatedAt: new Date().toISOString(),
    }, { merge: true });

    // Write audit log
    await this.writeAuditLog({
      userId,
      action: "KYC_SUBMITTED",
      timestamp: new Date().toISOString(),
      previousStatus: "UNVERIFIED",
      newStatus: "PENDING",
      requestId: `submit-kyc-${userId}-${Date.now()}`
    });

    logger.info(`[KycService] KYC submitted successfully. Status: PENDING for user: ${userId}`);
    return {
      success: true,
      status: "PENDING",
    };
  }

  /**
   * Helper to write immutable KYC audit logs securely to kyc_audit_logs collection
   */
  private static async writeAuditLog(log: {
    userId: string;
    action: "KYC_SUBMITTED" | "KYC_APPROVED" | "KYC_REJECTED" | "KYC_PROVISIONING_STARTED" | "KYC_PROVISIONING_SUCCESS" | "KYC_PROVISIONING_FAILED" | "KYC_PROVISIONING_RETRY";
    adminUid?: string;
    timestamp: string;
    previousStatus?: string;
    newStatus: string;
    reason?: string;
    requestId: string;
  }): Promise<void> {
    try {
      if (adminDb) {
        const docRef = adminDb.collection("kyc_audit_logs").doc();
        await docRef.set(log);
      }
    } catch (err: any) {
      logger.error(`[KycService] Failed to write KYC Audit Log: ${err.message}`);
    }
  }

  /**
   * Rejects a pending KYC submission
   */
  public static async rejectKyc(userId: string, adminUid: string, reason: string, requestId: string): Promise<any> {
    if (!adminDb) {
      throw new Error("Firestore Admin Database is not initialized.");
    }
    if (!reason || !reason.trim()) {
      throw new Error("Rejection reason is required.");
    }

    const submissionRef = adminDb.collection("kyc_submissions").doc(userId);
    const subSnap = await submissionRef.get();
    if (!subSnap.exists) {
      throw new Error("KYC submission record not found.");
    }

    const subData = subSnap.data() as KycSubmission;
    const prevStatus = subData.status;

    // Atomically claim the state transition PENDING -> REJECTED
    await adminDb.runTransaction(async (transaction) => {
      const freshSnap = await transaction.get(submissionRef);
      const freshData = freshSnap.data() as KycSubmission;
      if (freshData.status !== "PENDING" && freshData.status !== "PROCESSING" && freshData.status !== "PROVISIONING_FAILED") {
        throw new Error(`Cannot reject kyc in status ${freshData.status}`);
      }

      transaction.update(submissionRef, {
        status: "REJECTED",
        rejectionReason: reason,
        reviewedBy: adminUid,
        reviewedAt: new Date().toISOString(),
      });

      transaction.update(adminDb!.collection("users").doc(userId), {
        kycStatus: "REJECTED",
        kycRejectionReason: reason,
        kycRejectedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    });

    await this.writeAuditLog({
      userId,
      action: "KYC_REJECTED",
      adminUid,
      timestamp: new Date().toISOString(),
      previousStatus: prevStatus,
      newStatus: "REJECTED",
      reason,
      requestId
    });

    // Send KYC Rejected Push Notification
    try {
      const { NotificationService } = require("./notificationService");
      await NotificationService.sendPushNotification(userId, {
        title: "❌ KYC Identity Rejected",
        body: `Identity verification failed: ${reason}`,
        type: "security",
        url: "/profile",
      });
    } catch (notifErr: any) {
      logger.error(`[KycService rejectKyc Exception] Failed to send KYC rejection notification: ${notifErr.message}`);
    }

    return { success: true, status: "REJECTED" };
  }

  /**
   * Approves a pending KYC submission and triggers idempotency-safe virtual account provisioning
   */
  public static async approveKyc(userId: string, adminUid: string, requestId: string, provider: "flutterwave" | "squad"): Promise<any> {
    if (!adminDb) {
      throw new Error("Firestore Admin Database is not initialized.");
    }
    if (!provider || (provider !== "flutterwave" && provider !== "squad")) {
      throw new Error("A valid provider must be explicitly selected.");
    }

    const submissionRef = adminDb.collection("kyc_submissions").doc(userId);
    const subSnap = await submissionRef.get();
    if (!subSnap.exists) {
      throw new Error("KYC submission record not found.");
    }

    const subData = subSnap.data() as KycSubmission;
    if (subData.status === "VERIFIED") {
      logger.info(`[KycService] KYC already VERIFIED for user ${userId}. Skipping.`);
      return { success: true, status: "VERIFIED" };
    }

    // Check pre-flight: does this specific provider virtual account already exist in Firebase?
    const provAccountRef = adminDb.collection("wallet_accounts").doc(userId).collection("accounts").doc(provider);
    const provAccountDoc = await provAccountRef.get();
    if (provAccountDoc.exists) {
      logger.info(`[KycService] Pre-flight found existing ${provider} account details for user: ${userId}. Recovering state.`);
      const accData = provAccountDoc.data();

      // Ensure hash and user state is VERIFIED, and main document is aligned
      const hashedId = this.hashIdentityNumber(subData.documentNumber);
      await adminDb.collection("kyc_hashes").doc(hashedId).set({
        userId,
        documentType: subData.documentType,
        createdAt: new Date().toISOString(),
      });

      await adminDb.collection("users").doc(userId).set({
        kycStatus: "VERIFIED",
        kycDocumentType: subData.documentType,
        kycHashedId: hashedId,
        updatedAt: new Date().toISOString(),
      }, { merge: true });

      // Update main legacy wallet document
      await adminDb.collection("wallet_accounts").doc(userId).set({
        userId,
        accountNumber: accData?.accountNumber,
        bankName: accData?.bankName,
        accountName: accData?.accountName,
        currency: accData?.currency || "NGN",
        provider,
        isPermanent: true,
        status: "active",
        [`provider_${provider}`]: true,
        updatedAt: new Date().toISOString(),
      }, { merge: true });

      await submissionRef.set({
        status: "VERIFIED",
        reviewedBy: adminUid,
        reviewedAt: new Date().toISOString(),
      }, { merge: true });

      return {
        success: true,
        status: "VERIFIED",
        account: {
          bank_name: accData?.bankName,
          account_number: accData?.accountNumber,
          account_name: accData?.accountName,
          currency: accData?.currency,
        }
      };
    }

    // 1. Claim State transition PENDING -> PROCESSING via Transaction to guarantee lock
    logger.info(`[KycService] Claiming PENDING kyc lock for user ${userId}`);
    await adminDb.runTransaction(async (transaction) => {
      const freshSnap = await transaction.get(submissionRef);
      if (!freshSnap.exists) throw new Error("KYC submission record lost.");
      const freshData = freshSnap.data() as KycSubmission;

      if (freshData.status !== "PENDING" && freshData.status !== "PROVISIONING_FAILED") {
        throw new Error(`Cannot approve kyc submission that is currently in status: ${freshData.status}`);
      }

      transaction.update(submissionRef, {
        status: "PROCESSING",
        reviewedBy: adminUid,
        reviewedAt: new Date().toISOString(),
      });
    });

    await this.writeAuditLog({
      userId,
      action: "KYC_APPROVED",
      adminUid,
      timestamp: new Date().toISOString(),
      previousStatus: subData.status,
      newStatus: "PROCESSING",
      requestId
    });

    // 2. Provisioning Stage: Execute outside Firestore transaction
    return await this.provisionStaticVirtualAccount(userId, subData, adminUid, requestId, provider);
  }

  /**
   * Retries virtual account provisioning if it previously failed (status: PROVISIONING_FAILED)
   */
  public static async retryProvisioning(userId: string, adminUid: string, requestId: string, provider: "flutterwave" | "squad"): Promise<any> {
    if (!adminDb) {
      throw new Error("Firestore Admin Database is not initialized.");
    }
    if (!provider || (provider !== "flutterwave" && provider !== "squad")) {
      throw new Error("A valid provider must be explicitly selected.");
    }

    const submissionRef = adminDb.collection("kyc_submissions").doc(userId);
    const subSnap = await submissionRef.get();
    if (!subSnap.exists) {
      throw new Error("KYC submission record not found.");
    }

    const subData = subSnap.data() as KycSubmission;
    if (subData.status !== "PROVISIONING_FAILED") {
      throw new Error(`Cannot retry provisioning for user in status: ${subData.status}`);
    }

    // Transition state PROVISIONING_FAILED -> PROCESSING to lock concurrent retries
    await adminDb.runTransaction(async (transaction) => {
      const freshSnap = await transaction.get(submissionRef);
      const freshData = freshSnap.data() as KycSubmission;
      if (freshData.status !== "PROVISIONING_FAILED") {
        throw new Error("Another action is already processing this request.");
      }
      transaction.update(submissionRef, {
        status: "PROCESSING",
        reviewedBy: adminUid,
        reviewedAt: new Date().toISOString(),
      });
    });

    await this.writeAuditLog({
      userId,
      action: "KYC_PROVISIONING_RETRY",
      adminUid,
      timestamp: new Date().toISOString(),
      previousStatus: "PROVISIONING_FAILED",
      newStatus: "PROCESSING",
      requestId
    });

    return await this.provisionStaticVirtualAccount(userId, subData, adminUid, requestId, provider);
  }

  /**
   * Perform actual external S2S API call to provision Wema bank or GTBank virtual account
   */
  private static async provisionStaticVirtualAccount(
    userId: string,
    subData: KycSubmission,
    adminUid: string,
    requestId: string,
    provider: "flutterwave" | "squad"
  ): Promise<any> {
    const hashedId = this.hashIdentityNumber(subData.documentNumber);
    const submissionRef = adminDb!.collection("kyc_submissions").doc(userId);

    // 1. Establish deterministic tx_ref/idempotencyKey based on provider
    const tx_ref = (subData as any)[`${provider}TxRef`] || `${provider}-kyc-idempotent-${userId}`;

    // Persist txRef to submissions document if not already written so that future retries use the exact same key
    if (!(subData as any)[`${provider}TxRef`]) {
      await submissionRef.set({ [`${provider}TxRef`]: tx_ref }, { merge: true });
    }

    await this.writeAuditLog({
      userId,
      action: "KYC_PROVISIONING_STARTED",
      adminUid,
      timestamp: new Date().toISOString(),
      previousStatus: "PROCESSING",
      newStatus: "PROVISIONING",
      requestId
    });

    let allocatedAccount: any = null;

    // 2. Query Local Database Check First to ensure duplicate safety before S2S triggers
    const provAccountRef = adminDb!.collection("wallet_accounts").doc(userId).collection("accounts").doc(provider);
    const provAccountDoc = await provAccountRef.get();
    if (provAccountDoc.exists) {
      logger.info(`[KycService] Idempotency Match: Local ${provider} account already exists. Recovering details.`);
      const accData = provAccountDoc.data();
      allocatedAccount = {
        bank_name: accData?.bankName,
        account_number: accData?.accountNumber,
        account_name: accData?.accountName,
        currency: accData?.currency,
      };
    }

    // 3. Query Upstream Provider if not resolved locally in step 2
    if (!allocatedAccount && provider === "flutterwave") {
      try {
        logger.info(`[KycService] Flutterwave Idempotency Check: Querying FLW for reference | tx_ref=${tx_ref}`);
        const checkRes = await PaymentVerificationService.getVirtualAccountByRef(tx_ref, requestId);
        if (checkRes && checkRes.success) {
          logger.info(`[KycService] Flutterwave Idempotency Match found. Restoring details.`);
          allocatedAccount = {
            bank_name: checkRes.bank_name,
            account_number: checkRes.account_number,
            account_name: checkRes.account_name,
            currency: checkRes.currency,
          };
        }
      } catch (checkErr: any) {
        logger.warn(`[KycService] Flutterwave lookup error: ${checkErr.message}. Proceeding to create.`);
      }
    }

    // 4. Create Account if not resolved in pre-flight checks
    if (!allocatedAccount) {
      if (provider === "flutterwave") {
        try {
          logger.info(`[KycService] Creating Flutterwave virtual account. tx_ref=${tx_ref}`);
          const flwResult = await PaymentVerificationService.createVirtualAccount({
            email: subData.email,
            is_permanent: true,
            bvn: subData.documentNumber,
            tx_ref,
            phonenumber: subData.phone,
            firstname: subData.firstName,
            lastname: subData.lastName,
            requestId: `kyc-admin-approve-${userId}`,
            idempotencyKey: tx_ref,
          });

          if (flwResult.success) {
            allocatedAccount = {
              bank_name: flwResult.bank_name,
              account_number: flwResult.account_number,
              account_name: flwResult.account_name,
              currency: flwResult.currency,
            };
          } else {
            throw new Error(flwResult.message || "Failed to receive success from Flutterwave.");
          }
        } catch (flwErr: any) {
          logger.error(`[KycService] Flutterwave account creation failed: ${flwErr.message}`);
        }
      } else if (provider === "squad") {
        try {
          logger.info(`[KycService] Creating Squad virtual account. customer_identifier=${tx_ref}`);
          const squadResult = await SquadService.createVirtualAccount({
            email: subData.email,
            firstName: subData.firstName,
            lastName: subData.lastName,
            phone: subData.phone,
            bvn: subData.documentNumber,
            customer_identifier: tx_ref,
            requestId: `kyc-admin-approve-${userId}`,
          });

          if (squadResult.success) {
            allocatedAccount = {
              bank_name: squadResult.bank_name,
              account_number: squadResult.account_number,
              account_name: squadResult.account_name,
              currency: squadResult.currency,
            };
          } else {
            throw new Error(squadResult.message || "Failed to receive success from Squadco.");
          }
        } catch (squadErr: any) {
          logger.error(`[KycService] Squadco account creation failed: ${squadErr.message}`);
        }
      }
    }

    if (allocatedAccount) {
      // 5. On Success: Save duplicate checks and transition user state to VERIFIED
      const hashDocRef = adminDb!.collection("kyc_hashes").doc(hashedId);
      await hashDocRef.set({
        userId,
        documentType: subData.documentType,
        createdAt: new Date().toISOString(),
      });

      // Persist to provider-specific subcollection document
      await provAccountRef.set({
        userId,
        accountNumber: allocatedAccount.account_number,
        bankName: allocatedAccount.bank_name,
        accountName: allocatedAccount.account_name,
        currency: allocatedAccount.currency || "NGN",
        reference: tx_ref,
        provider,
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // Update legacy main document (maintaining default account number details for backward compatibility)
      await adminDb!.collection("wallet_accounts").doc(userId).set({
        userId,
        accountNumber: allocatedAccount.account_number,
        bankName: allocatedAccount.bank_name,
        accountName: allocatedAccount.account_name,
        currency: allocatedAccount.currency || "NGN",
        provider,
        isPermanent: true,
        status: "active",
        [`provider_${provider}`]: true,
        updatedAt: new Date().toISOString(),
      }, { merge: true });

      // Update user state and submission state
      await adminDb!.collection("users").doc(userId).set({
        kycStatus: "VERIFIED",
        kycDocumentType: subData.documentType,
        kycHashedId: hashedId,
        kycVerifiedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }, { merge: true });

      await submissionRef.set({
        status: "VERIFIED",
        reviewedBy: adminUid,
        reviewedAt: new Date().toISOString(),
      }, { merge: true });

      await this.writeAuditLog({
        userId,
        action: "KYC_PROVISIONING_SUCCESS",
        adminUid,
        timestamp: new Date().toISOString(),
        previousStatus: "PROVISIONING",
        newStatus: "VERIFIED",
        requestId
      });

      // Send KYC Approved Notification
      try {
        const { NotificationService } = require("./notificationService");
        await NotificationService.sendPushNotification(userId, {
          title: "🎉 KYC Identity Approved",
          body: `Congratulations! Your identity has been verified and your virtual account has been allocated via ${provider === "squad" ? "Squad" : "Flutterwave"}.`,
          type: "security",
          url: "/profile",
        });
      } catch (notifErr: any) {
        logger.error(`[KycService approved notification] Failed to send KYC approved push: ${notifErr.message}`);
      }

      return {
        success: true,
        status: "VERIFIED",
        account: allocatedAccount
      };
    } else {
      // 6. On Failure: Update state to PROVISIONING_FAILED (retryable)
      await submissionRef.set({
        status: "PROVISIONING_FAILED",
      }, { merge: true });

      await this.writeAuditLog({
        userId,
        action: "KYC_PROVISIONING_FAILED",
        adminUid,
        timestamp: new Date().toISOString(),
        previousStatus: "PROVISIONING",
        newStatus: "PROVISIONING_FAILED",
        reason: `${provider === "squad" ? "Squad" : "Flutterwave"} static virtual account allocation failed.`,
        requestId
      });

      // Update user kycStatus in users collection back to PROVISIONING_FAILED
      await adminDb!.collection("users").doc(userId).set({
        kycStatus: "PROVISIONING_FAILED",
        updatedAt: new Date().toISOString(),
      }, { merge: true });

      throw new Error(`Bank account allocation failed via ${provider}. State preserved as PROVISIONING_FAILED.`);
    }
  }

  /**
   * Processes full KYC identity check, face liveness, duplicate prevention, and provisions accounts
   */
  public static async verifyKyc(req: KycVerificationRequest): Promise<any> {
    // Deprecated for production in favor of human approval state machine.
    // Call submitKyc instead.
    return this.submitKyc(req);
  }
}
