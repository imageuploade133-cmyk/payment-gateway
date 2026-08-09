import { KycService } from "../services/kycService";
import { PaymentVerificationService } from "../services/paymentVerificationService";
import { SquadService } from "../services/squadService";
import adminDb from "../config/firebase";

// Mock Firebase Admin SDK with in-memory map emulation for documents
const store: Record<string, any> = {};

jest.mock("firebase-admin/app", () => ({
  getApps: jest.fn(() => [{ name: "[DEFAULT]" }]),
  initializeApp: jest.fn(),
  cert: jest.fn(),
}));

jest.mock("../config/firebase", () => {
  return {
    __esModule: true,
    default: {
      collection: (colName: string) => ({
        doc: (docId: string) => {
          const makeMockDoc = (dId: string) => ({
            get: jest.fn().mockImplementation(async () => {
              const key = `${colName}/${dId}`;
              const val = store[key];
              return {
                exists: !!val,
                data: () => val || null,
              };
            }),
            set: jest.fn().mockImplementation(async (data: any, options?: { merge?: boolean }) => {
              const key = `${colName}/${dId}`;
              if (options?.merge && store[key]) {
                store[key] = { ...store[key], ...data };
              } else {
                store[key] = data;
              }
            }),
            update: jest.fn().mockImplementation(async (data: any) => {
              const key = `${colName}/${dId}`;
              store[key] = { ...store[key], ...data };
            }),
            collection: (subCol: string) => {
              return {
                doc: (subId: string) => makeMockDoc(`${dId}/${subCol}/${subId}`),
              };
            },
          });
          return makeMockDoc(docId);
        },
      }),
      runTransaction: jest.fn().mockImplementation(async (callback) => {
        const transactionMock = {
          get: jest.fn().mockImplementation(async (docRef: any) => {
            return docRef.get();
          }),
          set: jest.fn().mockImplementation(async (docRef: any, data: any) => {
            await docRef.set(data);
          }),
          update: jest.fn().mockImplementation(async (docRef: any, data: any) => {
            await docRef.update(data);
          }),
        };
        return await callback(transactionMock);
      }),
    },
  };
});

// Mock notification service
jest.mock("../services/notificationService", () => {
  return {
    NotificationService: {
      sendPushNotification: jest.fn().mockResolvedValue({ success: true }),
    },
  };
});

// Spy/Mock PaymentVerificationService & SquadService
jest.spyOn(PaymentVerificationService, "createVirtualAccount");
jest.spyOn(PaymentVerificationService, "getVirtualAccountByRef");
jest.spyOn(SquadService, "createVirtualAccount");

describe("KYC Deep Idempotency and Recovery Tests", () => {
  const userId = "idemp-user-123";
  const mockAdminUid = "admin-999";
  const mockRequestId = "req-101010";

  beforeEach(() => {
    jest.clearAllMocks();
    // Clean memory store
    for (const key in store) {
      delete store[key];
    }
  });

  it("should successfully submit KYC as PENDING and block duplicates when verified in kyc_hashes", async () => {
    const kycReq = {
      userId,
      firstName: "James",
      lastName: "Holden",
      documentType: "bvn" as const,
      documentNumber: "12345678901",
      email: "james@roci.com",
      phone: "08012345678",
    };

    const res = await KycService.submitKyc(kycReq);
    expect(res.success).toBe(true);
    expect(res.status).toBe("PENDING");

    // Verify stored submission
    const storedSub = store["kyc_submissions/" + userId];
    expect(storedSub).toBeDefined();
    expect(storedSub.status).toBe("PENDING");
    expect(storedSub.documentNumber).toBe("12345678901");

    // Verify user profile is marked PENDING
    const storedUser = store["users/" + userId];
    expect(storedUser).toBeDefined();
    expect(storedUser.kycStatus).toBe("PENDING");

    // Add this BVN to kyc_hashes to simulate that user 1 got verified
    const hashedId = KycService.hashIdentityNumber("12345678901");
    store["kyc_hashes/" + hashedId] = {
      userId,
      documentType: "bvn",
      createdAt: new Date().toISOString(),
    };

    // Attempting a duplicate KYC from another user with same identity number should now throw
    await expect(
      KycService.submitKyc({
        ...kycReq,
        userId: "other-user-999",
      })
    ).rejects.toThrow("This BVN or NIN is already verified on another account.");
  });

  it("should perform human admin approval, query Flutterwave first, and provision upon cache-miss", async () => {
    // Prime the mock database with a pending submission
    store["kyc_submissions/" + userId] = {
      userId,
      firstName: "James",
      lastName: "Holden",
      documentType: "bvn",
      documentNumber: "12345678901",
      email: "james@roci.com",
      phone: "08012345678",
      status: "PENDING",
    };

    // Mock getVirtualAccountByRef returning not-found (cache miss)
    (PaymentVerificationService.getVirtualAccountByRef as jest.Mock).mockResolvedValueOnce({
      success: false,
    });

    // Mock createVirtualAccount returning success
    (PaymentVerificationService.createVirtualAccount as jest.Mock).mockResolvedValueOnce({
      success: true,
      bank_name: "Wema Bank",
      account_number: "9900012345",
      account_name: "James Holden",
      currency: "NGN",
      reference: `flutterwave-kyc-idempotent-${userId}`,
    });

    const approveRes = await KycService.approveKyc(userId, mockAdminUid, mockRequestId, "flutterwave");

    expect(approveRes.success).toBe(true);
    expect(approveRes.status).toBe("VERIFIED");
    expect(approveRes.account.account_number).toBe("9900012345");

    // Verify database state updated to VERIFIED
    expect(store["kyc_submissions/" + userId].status).toBe("VERIFIED");
    expect(store["users/" + userId].kycStatus).toBe("VERIFIED");
    expect(store["wallet_accounts/" + userId]).toBeDefined();
    expect(store["wallet_accounts/" + userId].accountNumber).toBe("9900012345");

    // Verify subcollection has account
    expect(store[`wallet_accounts/${userId}/accounts/flutterwave`]).toBeDefined();
    expect(store[`wallet_accounts/${userId}/accounts/flutterwave`].accountNumber).toBe("9900012345");

    // Verify calls: checked reference lookup first, then created account
    expect(PaymentVerificationService.getVirtualAccountByRef).toHaveBeenCalledWith(
      `flutterwave-kyc-idempotent-${userId}`,
      mockRequestId
    );
    expect(PaymentVerificationService.createVirtualAccount).toHaveBeenCalled();
  });

  it("should perform human admin approval via Squadco, formatting phone correctly", async () => {
    store["kyc_submissions/" + userId] = {
      userId,
      firstName: "James",
      lastName: "Holden",
      documentType: "bvn",
      documentNumber: "12345678901",
      email: "james@roci.com",
      phone: "+2348012345678",
      status: "PENDING",
    };

    (SquadService.createVirtualAccount as jest.Mock).mockResolvedValueOnce({
      success: true,
      bank_name: "Guaranty Trust Bank",
      account_number: "5544332211",
      account_name: "James Holden",
      currency: "NGN",
    });

    const approveRes = await KycService.approveKyc(userId, mockAdminUid, mockRequestId, "squad");

    expect(approveRes.success).toBe(true);
    expect(approveRes.status).toBe("VERIFIED");
    expect(approveRes.account.account_number).toBe("5544332211");

    // Verify stored in squad subcollection
    expect(store[`wallet_accounts/${userId}/accounts/squad`]).toBeDefined();
    expect(store[`wallet_accounts/${userId}/accounts/squad`].accountNumber).toBe("5544332211");

    // Verify legacy main document points to Squad
    expect(store["wallet_accounts/" + userId].provider).toBe("squad");
    expect(store["wallet_accounts/" + userId].accountNumber).toBe("5544332211");

    // Check SquadService call format
    expect(SquadService.createVirtualAccount).toHaveBeenCalledWith({
      email: "james@roci.com",
      firstName: "James",
      lastName: "Holden",
      phone: "+2348012345678",
      bvn: "12345678901",
      customer_identifier: `squad-kyc-idempotent-${userId}`,
      requestId: `kyc-admin-approve-${userId}`,
    });
  });

  it("should satisfy crash-recovery pre-flight idempotency (skip FLW creation if reference exists)", async () => {
    // Imagine the server previously crashed right after Flutterwave allocated the virtual account but before updating Firestore.
    // Now the admin triggers approval retry.
    store["kyc_submissions/" + userId] = {
      userId,
      firstName: "James",
      lastName: "Holden",
      documentType: "bvn",
      documentNumber: "12345678901",
      email: "james@roci.com",
      phone: "08012345678",
      status: "PENDING",
      flutterwaveTxRef: `flutterwave-kyc-idempotent-${userId}`, // persistent reference already attached
    };

    // Pre-flight check simulates resolving an already-created account on Flutterwave
    (PaymentVerificationService.getVirtualAccountByRef as jest.Mock).mockResolvedValueOnce({
      success: true,
      bank_name: "Wema Bank",
      account_number: "9900012345",
      account_name: "James Holden",
      currency: "NGN",
    });

    const approveRes = await KycService.approveKyc(userId, mockAdminUid, mockRequestId, "flutterwave");

    // Verify recovery succeeded
    expect(approveRes.success).toBe(true);
    expect(approveRes.status).toBe("VERIFIED");
    expect(approveRes.account.account_number).toBe("9900012345");

    // Verify Flutterwave API create was NOT called again (preventing multiple account allocations)
    expect(PaymentVerificationService.createVirtualAccount).not.toHaveBeenCalled();
    expect(store["wallet_accounts/" + userId].accountNumber).toBe("9900012345");
  });

  it("should gracefully transition to PROVISIONING_FAILED on provider errors, and support manual retry", async () => {
    store["kyc_submissions/" + userId] = {
      userId,
      firstName: "James",
      lastName: "Holden",
      documentType: "bvn",
      documentNumber: "12345678901",
      email: "james@roci.com",
      phone: "08012345678",
      status: "PENDING",
    };

    // FLW lookup and create both fail
    (PaymentVerificationService.getVirtualAccountByRef as jest.Mock).mockResolvedValueOnce({ success: false });
    (PaymentVerificationService.createVirtualAccount as jest.Mock).mockResolvedValueOnce({
      success: false,
      message: "Upstream gateway connection timeout.",
    });

    // Approval fails provisioning
    await expect(KycService.approveKyc(userId, mockAdminUid, mockRequestId, "flutterwave")).rejects.toThrow(
      "Bank account allocation failed"
    );

    // State becomes PROVISIONING_FAILED
    expect(store["kyc_submissions/" + userId].status).toBe("PROVISIONING_FAILED");
    expect(store["users/" + userId].kycStatus).toBe("PROVISIONING_FAILED");

    // Now, admin invokes retry action once upstream connection clears up
    (PaymentVerificationService.getVirtualAccountByRef as jest.Mock).mockResolvedValueOnce({ success: false });
    (PaymentVerificationService.createVirtualAccount as jest.Mock).mockResolvedValueOnce({
      success: true,
      bank_name: "Wema Bank",
      account_number: "9900055555",
      account_name: "James Holden",
      currency: "NGN",
      reference: `flutterwave-kyc-idempotent-${userId}`,
    });

    const retryRes = await KycService.retryProvisioning(userId, mockAdminUid, mockRequestId, "flutterwave");
    expect(retryRes.success).toBe(true);
    expect(retryRes.status).toBe("VERIFIED");
    expect(store["wallet_accounts/" + userId].accountNumber).toBe("9900055555");
  });
});
