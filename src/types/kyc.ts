export type KycStatus = "PENDING" | "PROCESSING" | "PROVISIONING" | "VERIFIED" | "PROVISIONING_FAILED" | "REJECTED";

export interface KycSubmission {
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  documentType: "bvn" | "nin";
  documentNumber: string;
  capturedSelfie?: string;
  livenessChallenge?: string;
  status: KycStatus;
  submittedAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
  rejectionReason?: string;
}

export interface KycAuditLog {
  userId: string;
  action: "KYC_SUBMITTED" | "KYC_APPROVED" | "KYC_REJECTED" | "KYC_PROVISIONING_STARTED" | "KYC_PROVISIONING_SUCCESS" | "KYC_PROVISIONING_FAILED" | "KYC_PROVISIONING_RETRY";
  adminUid?: string;
  timestamp: string;
  previousStatus?: string;
  newStatus: string;
  reason?: string;
  requestId: string;
}
