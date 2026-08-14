import { KycService } from "../services/kycService";
import { PaymentVerificationService } from "../services/paymentVerificationService";
import { SquadService } from "../services/squadService";
import adminDb from "../config/firebase";
import axios from "axios";
import { env } from "../config/env";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

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
    // Set a default SQUAD_BENEFICIARY_ACCOUNT for standard tests
    env.SQUAD_BENEFICIARY_ACCOUNT = "1234567890";
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

  describe("Squad Comprehensive KYC & Virtual Account Integration", () => {
    beforeEach(() => {
      // Restore spy to call through to original implementation
      try {
        (SquadService.createVirtualAccount as any).mockRestore();
      } catch (e) {}
      jest.spyOn(SquadService, "createVirtualAccount");
    });

    it("should succeed with complete KYC having middle name and phone", async () => {
      // Complete KYC with a middle name in firstName
      store["kyc_submissions/" + userId] = {
        userId,
        firstName: "James Alister",
        lastName: "Holden",
        documentType: "bvn",
        documentNumber: "12345678901",
        email: "james@roci.com",
        phone: "+2348012345678",
        status: "PENDING",
      };

      // Mock Squad API success response
      mockedAxios.post.mockResolvedValueOnce({
        data: {
          success: true,
          data: {
            bank_name: "Guaranty Trust Bank",
            account_number: "5544332211",
            account_name: "James Alister Holden",
            currency: "NGN",
          },
        },
      });

      const approveRes = await KycService.approveKyc(userId, mockAdminUid, mockRequestId, "squad");
      expect(approveRes.success).toBe(true);
      expect(approveRes.status).toBe("VERIFIED");
      expect(approveRes.account.account_number).toBe("5544332211");
      expect(approveRes.account.bank_name).toBe("Guaranty Trust Bank");
    });

    it("should succeed with KYC without middle name", async () => {
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

      mockedAxios.post.mockResolvedValueOnce({
        data: {
          success: true,
          data: {
            bank_name: "Guaranty Trust Bank",
            account_number: "5544332211",
            account_name: "James Holden",
            currency: "NGN",
          },
        },
      });

      const approveRes = await KycService.approveKyc(userId, mockAdminUid, mockRequestId, "squad");
      expect(approveRes.success).toBe(true);
      expect(approveRes.account.account_number).toBe("5544332211");
    });

    it("should fail validation if KYC and user profile are missing phone", async () => {
      store["kyc_submissions/" + userId] = {
        userId,
        firstName: "James",
        lastName: "Holden",
        documentType: "bvn",
        documentNumber: "12345678901",
        email: "james@roci.com",
        phone: "", // Missing
        status: "PENDING",
      };

      store["users/" + userId] = {
        uid: userId,
        email: "james@roci.com",
        phoneNumber: "", // Also missing
      };

      await expect(KycService.approveKyc(userId, mockAdminUid, mockRequestId, "squad")).rejects.toThrow(
        "Squad provisioning validation failed: mobile number is missing from verified KYC record"
      );
    });

    it("should fail validation with empty phone string", async () => {
      const params = {
        email: "james@roci.com",
        firstName: "James",
        lastName: "Holden",
        phone: "",
        bvn: "12345678901",
        customer_identifier: "squad-kyc-idempotent-" + userId,
        requestId: "req-111",
      };

      await expect(SquadService.createVirtualAccount(params)).rejects.toThrow(
        "Squad provisioning validation failed: mobile number is missing from verified KYC record"
      );
    });

    it("should fail validation with whitespace-only phone", async () => {
      const params = {
        email: "james@roci.com",
        firstName: "James",
        lastName: "Holden",
        phone: "    ",
        bvn: "12345678901",
        customer_identifier: "squad-kyc-idempotent-" + userId,
        requestId: "req-111",
      };

      await expect(SquadService.createVirtualAccount(params)).rejects.toThrow(
        "Squad provisioning validation failed: mobile number is missing from verified KYC record"
      );
    });

    it("should correctly normalize various Nigerian phone formats to 11 digits", async () => {
      // Test normalization helper via actual validation
      const params = {
        email: "james@roci.com",
        firstName: "James",
        lastName: "Holden",
        phone: "+234 801-234-5678", // complex formatting
        bvn: "12345678901",
        customer_identifier: "squad-kyc-idempotent-" + userId,
        requestId: "req-111",
      };

      mockedAxios.post.mockResolvedValueOnce({
        data: {
          success: true,
          data: {
            bank_name: "Guaranty Trust Bank",
            account_number: "5544332211",
            account_name: "James Holden",
            currency: "NGN",
          },
        },
      });

      const res = await SquadService.createVirtualAccount(params);
      expect(res.success).toBe(true);

      // Verify what got called to post
      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          mobile_num: "08012345678", // Normalized perfectly to 11 local digits!
        }),
        expect.any(Object)
      );
    });

    it("should fail validation when first name is missing", async () => {
      const params = {
        email: "james@roci.com",
        firstName: "",
        lastName: "Holden",
        phone: "08012345678",
        bvn: "12345678901",
        customer_identifier: "squad-kyc-idempotent-" + userId,
        requestId: "req-111",
      };

      await expect(SquadService.createVirtualAccount(params)).rejects.toThrow(
        "Squad provisioning validation failed: first name is missing from verified KYC record"
      );
    });

    it("should fail validation when last name is missing", async () => {
      const params = {
        email: "james@roci.com",
        firstName: "James",
        lastName: "   ",
        phone: "08012345678",
        bvn: "12345678901",
        customer_identifier: "squad-kyc-idempotent-" + userId,
        requestId: "req-111",
      };

      await expect(SquadService.createVirtualAccount(params)).rejects.toThrow(
        "Squad provisioning validation failed: last name is missing from verified KYC record"
      );
    });

    it("should fail validation when email is missing", async () => {
      const params = {
        email: "",
        firstName: "James",
        lastName: "Holden",
        phone: "08012345678",
        bvn: "12345678901",
        customer_identifier: "squad-kyc-idempotent-" + userId,
        requestId: "req-111",
      };

      await expect(SquadService.createVirtualAccount(params)).rejects.toThrow(
        "Squad provisioning validation failed: email is missing from verified KYC record"
      );
    });

    it("should fail validation when bvn (document number) is missing", async () => {
      const params = {
        email: "james@roci.com",
        firstName: "James",
        lastName: "Holden",
        phone: "08012345678",
        bvn: "  ",
        customer_identifier: "squad-kyc-idempotent-" + userId,
        requestId: "req-111",
      };

      await expect(SquadService.createVirtualAccount(params)).rejects.toThrow(
        "Squad provisioning validation failed: bvn is missing from verified KYC record"
      );
    });

    it("should fail validation when customer identifier is missing", async () => {
      const params = {
        email: "james@roci.com",
        firstName: "James",
        lastName: "Holden",
        phone: "08012345678",
        bvn: "12345678901",
        customer_identifier: "",
        requestId: "req-111",
      };

      await expect(SquadService.createVirtualAccount(params)).rejects.toThrow(
        "Squad provisioning validation failed: customer identifier is missing from verified KYC record"
      );
    });

    it("should handle Squadco API HTTP 400 error and transition state correctly", async () => {
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

      // Mock Squad API 400 failure
      mockedAxios.post.mockRejectedValueOnce({
        response: {
          status: 400,
          data: {
            status: 400,
            success: false,
            message: "Invalid BVN payload mismatch",
          },
        },
      });

      await expect(KycService.approveKyc(userId, mockAdminUid, mockRequestId, "squad")).rejects.toThrow(
        "Bank account allocation failed via squad. State preserved as PROVISIONING_FAILED."
      );

      expect(store["kyc_submissions/" + userId].status).toBe("PROVISIONING_FAILED");
      expect(store["users/" + userId].kycStatus).toBe("PROVISIONING_FAILED");
    });

    it("should retry successfully from PROVISIONING_FAILED and register", async () => {
      store["kyc_submissions/" + userId] = {
        userId,
        firstName: "James",
        lastName: "Holden",
        documentType: "bvn",
        documentNumber: "12345678901",
        email: "james@roci.com",
        phone: "08012345678",
        status: "PROVISIONING_FAILED",
      };

      mockedAxios.post.mockResolvedValueOnce({
        data: {
          success: true,
          data: {
            bank_name: "Guaranty Trust Bank",
            account_number: "5544332211",
            account_name: "James Holden",
            currency: "NGN",
          },
        },
      });

      const retryRes = await KycService.retryProvisioning(userId, mockAdminUid, mockRequestId, "squad");
      expect(retryRes.success).toBe(true);
      expect(retryRes.status).toBe("VERIFIED");
      expect(store["wallet_accounts/" + userId].accountNumber).toBe("5544332211");
    });

    it("should prevent duplicate approval when user KYC is already VERIFIED", async () => {
      store["kyc_submissions/" + userId] = {
        userId,
        firstName: "James",
        lastName: "Holden",
        documentType: "bvn",
        documentNumber: "12345678901",
        email: "james@roci.com",
        phone: "08012345678",
        status: "VERIFIED",
      };

      const approveRes = await KycService.approveKyc(userId, mockAdminUid, mockRequestId, "squad");
      expect(approveRes.success).toBe(true);
      expect(approveRes.status).toBe("VERIFIED");

      // Verify Squad API was NOT called again
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it("should satisfy crash-recovery pre-flight idempotency on retry with pre-existing wallet account details", async () => {
      store["kyc_submissions/" + userId] = {
        userId,
        firstName: "James",
        lastName: "Holden",
        documentType: "bvn",
        documentNumber: "12345678901",
        email: "james@roci.com",
        phone: "08012345678",
        status: "PROVISIONING_FAILED",
      };

      // Simulate local Firestore wallet_accounts has already recorded squad details from a past partial run
      store[`wallet_accounts/${userId}/accounts/squad`] = {
        userId,
        accountNumber: "5544332211",
        bankName: "Guaranty Trust Bank",
        accountName: "James Holden",
        currency: "NGN",
      };

      const retryRes = await KycService.retryProvisioning(userId, mockAdminUid, mockRequestId, "squad");
      expect(retryRes.success).toBe(true);
      expect(retryRes.status).toBe("VERIFIED");
      expect(retryRes.account.account_number).toBe("5544332211");

      // Verify Squad API was bypassed due to local pre-flight match
      expect(mockedAxios.post).not.toHaveBeenCalled();
    });

    it("should fail validation if SQUAD_BENEFICIARY_ACCOUNT is missing/empty", async () => {
      env.SQUAD_BENEFICIARY_ACCOUNT = "";

      const params = {
        email: "james@roci.com",
        firstName: "James",
        lastName: "Holden",
        phone: "08012345678",
        bvn: "12345678901",
        customer_identifier: "squad-kyc-idempotent-" + userId,
        requestId: "req-111",
      };

      await expect(SquadService.createVirtualAccount(params)).rejects.toThrow(
        "Squad provisioning validation failed: SQUAD_BENEFICIARY_ACCOUNT environment variable is missing or empty"
      );
    });

    it("should fail validation if SQUAD_BENEFICIARY_ACCOUNT is not exactly 10 digits", async () => {
      env.SQUAD_BENEFICIARY_ACCOUNT = "12345"; // Invalid length

      const params = {
        email: "james@roci.com",
        firstName: "James",
        lastName: "Holden",
        phone: "08012345678",
        bvn: "12345678901",
        customer_identifier: "squad-kyc-idempotent-" + userId,
        requestId: "req-111",
      };

      await expect(SquadService.createVirtualAccount(params)).rejects.toThrow(
        "Squad provisioning validation failed: SQUAD_BENEFICIARY_ACCOUNT must be exactly 10 digits"
      );
    });

    it("should include a valid SQUAD_BENEFICIARY_ACCOUNT in the post payload", async () => {
      env.SQUAD_BENEFICIARY_ACCOUNT = "9988776655";

      const params = {
        email: "james@roci.com",
        firstName: "James",
        lastName: "Holden",
        phone: "08012345678",
        bvn: "12345678901",
        customer_identifier: "squad-kyc-idempotent-" + userId,
        requestId: "req-111",
      };

      mockedAxios.post.mockResolvedValueOnce({
        data: {
          success: true,
          data: {
            bank_name: "Guaranty Trust Bank",
            account_number: "5544332211",
            account_name: "James Holden",
            currency: "NGN",
          },
        },
      });

      const res = await SquadService.createVirtualAccount(params);
      expect(res.success).toBe(true);

      // Verify the correct beneficiary_account property is included in the payload sent to Squad
      expect(mockedAxios.post).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          beneficiary_account: "9988776655",
        }),
        expect.any(Object)
      );
    });

    it("should successfully retry provisioning when state is stuck in PROCESSING", async () => {
      store["kyc_submissions/" + userId] = {
        userId,
        firstName: "James",
        lastName: "Holden",
        documentType: "bvn",
        documentNumber: "12345678901",
        email: "james@roci.com",
        phone: "08012345678",
        status: "PROCESSING", // stuck in PROCESSING
      };

      // Mock Squad API to return existing/success details
      mockedAxios.post.mockResolvedValueOnce({
        data: {
          success: true,
          data: {
            bank_name: "Guaranty Trust Bank",
            virtual_account_number: "5544332211",
            account_name: "James Holden",
            currency: "NGN",
          },
        },
      });

      const retryRes = await KycService.retryProvisioning(userId, mockAdminUid, mockRequestId, "squad");
      expect(retryRes.success).toBe(true);
      expect(retryRes.status).toBe("VERIFIED");
      expect(retryRes.account.account_number).toBe("5544332211");

      // Submission status should now be VERIFIED
      expect(store["kyc_submissions/" + userId].status).toBe("VERIFIED");
    });

    it("should recover existing account details from Squad conflict response", async () => {
      const params = {
        email: "james@roci.com",
        firstName: "James",
        lastName: "Holden",
        phone: "08012345678",
        bvn: "12345678901",
        customer_identifier: "squad-kyc-idempotent-" + userId,
        requestId: "req-111",
      };

      // Mock to return 400 with duplicate message
      mockedAxios.post.mockRejectedValueOnce({
        response: {
          status: 400,
          data: {
            success: false,
            message: "customer_identifier already exists",
            data: {
              bank_name: "Guaranty Trust Bank",
              virtual_account_number: "5544332211",
              account_name: "James Holden",
              currency: "NGN",
            },
          },
        },
      });

      const res = await SquadService.createVirtualAccount(params);
      expect(res.success).toBe(true);
      expect(res.account_number).toBe("5544332211");
    });
  });
});
