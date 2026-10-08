import { extractSenderInfo } from "../utils/senderExtractor";
import { WalletFundingService } from "../services/walletFundingService";
import { adminDb } from "../config/firebase";

// Mock Firebase Admin SDK for persistence boundary testing
jest.mock("../config/firebase", () => {
  const mDocs: Record<string, any> = {};
  return {
    adminDb: {
      collection: (colName: string) => ({
        doc: (docId: string) => ({
          get: jest.fn().mockImplementation(async () => {
            const data = mDocs[`${colName}/${docId}`];
            return {
              exists: !!data,
              data: () => data,
            };
          }),
          set: jest.fn().mockImplementation(async (data: any, opts: any) => {
            if (opts?.merge && mDocs[`${colName}/${docId}`]) {
              mDocs[`${colName}/${docId}`] = { ...mDocs[`${colName}/${docId}`], ...data };
            } else {
              mDocs[`${colName}/${docId}`] = data;
            }
          }),
          update: jest.fn(),
        }),
        where: () => ({
          get: jest.fn().mockResolvedValue({ empty: true, docs: [] }),
        }),
      }),
      runTransaction: jest.fn().mockImplementation(async (cb: any) => {
        const fakeTx = {
          get: async (docRef: any) => docRef.get(),
          set: async (docRef: any, data: any, opts: any) => docRef.set(data, opts),
          update: async (docRef: any, data: any) => docRef.set(data, { merge: true }),
        };
        return cb(fakeTx);
      }),
    },
  };
});

describe("Sender Extractor Utility & Final Persistence Boundary Security Suite", () => {
  // Test A — Correct authoritative sender
  it("Test A: Correct authoritative sender extraction from originator fields", () => {
    const payload = {
      meta_data: {
        originatorname: "John Doe",
        originatorbankname: "GTBank",
        originatoraccountnumber: "1234567890",
      },
    };

    const sender = extractSenderInfo(payload);
    expect(sender.senderName).toBe("John Doe");
    expect(sender.senderBankName).toBe("GTBank");
    expect(sender.senderAccountNumber).toBe("1234567890");
  });

  // Test B — Receiving bank must NOT become sender bank
  it("Test B: Receiving bank (bank_name: Wema Bank) must NOT become sender bank", () => {
    const payload = {
      amount: 10000,
      bank_name: "Wema Bank",
      account_number: "9988776655",
      customer: {
        name: "WALLET OWNER",
      },
    };

    const sender = extractSenderInfo(payload);
    expect(sender.senderBankName).toBeNull();
    expect(sender.senderName).toBeNull();
  });

  // Test C — Generic metadata bank variants must EACH result in senderBankName === null
  it("Test C: Generic metadata bank variants (bank_name, bankname, bankName, bank) must EACH result in senderBankName === null", () => {
    const genericVariants = ["bank_name", "bankname", "bankName", "bank"];

    for (const key of genericVariants) {
      // Test inside meta_data
      const metaPayload = {
        meta_data: {
          [key]: "Wema Bank",
        },
      };
      expect(extractSenderInfo(metaPayload).senderBankName).toBeNull();

      // Test inside meta
      const metaObjPayload = {
        meta: {
          [key]: "Wema Bank",
        },
      };
      expect(extractSenderInfo(metaObjPayload).senderBankName).toBeNull();

      // Test top-level
      const topLevelPayload = {
        [key]: "Wema Bank",
      };
      expect(extractSenderInfo(topLevelPayload).senderBankName).toBeNull();
    }
  });

  // Test D — Explicit originator bank works
  it("Test D: Explicit originator bank works (originatorbankname: GTBank)", () => {
    const payload = {
      meta_data: {
        originatorbankname: "GTBank",
      },
    };

    const sender = extractSenderInfo(payload);
    expect(sender.senderBankName).toBe("GTBank");
  });

  // Test E — Missing sender metadata
  it("Test E: Missing sender metadata results in null rather than fabricated values", () => {
    const payload = {
      amount: 5000,
      currency: "NGN",
      customer: {
        email: "user@example.com",
      },
    };

    const sender = extractSenderInfo(payload);
    expect(sender.senderName).toBeNull();
    expect(sender.senderBankName).toBeNull();
    expect(sender.senderAccountNumber).toBeNull();
    expect(sender.senderBankCode).toBeNull();
  });

  // Test F — Customer/recipient fields cannot become sender
  it("Test F: Customer/recipient fields (customerName, accountName, beneficiaryName) cannot become senderName", () => {
    const payload = {
      customer: {
        name: "CUSTOMER RECIPIENT NAME",
      },
      customerName: "CUSTOMER RECIPIENT NAME",
      account_name: "RECIPIENT ACCOUNT HOLDER",
      virtual_account_name: "VA HOLDER NAME",
      beneficiary_name: "BENEFICIARY NAME",
      recipient_name: "RECIPIENT NAME",
    };

    const sender = extractSenderInfo(payload);
    expect(sender.senderName).toBeNull();
  });

  // Test G — Final persistence boundary cannot be bypassed
  it("Test G: Final persistence boundary in WalletFundingService proves raw payloadData fallback bypass is prevented", async () => {
    const targetUid = "test-user-boundary-123";
    const flwId = "flw-boundary-test-999";
    const txRef = `flw-tx-${targetUid}-1001`;

    const db = adminDb!;
    await db.collection("users").doc(targetUid).set({ balance: 0, email: "boundary@example.com" });

    // Payload where sender_name matches customer name (wallet owner), and bank_name is generic receiving bank
    const payloadData = {
      amount: 5000,
      bank_name: "Wema Bank",
      account_number: "1234567890",
      sender_name: "WALLET OWNER NAME",
      customer: {
        name: "WALLET OWNER NAME",
        email: "boundary@example.com",
      },
    };

    const result = await WalletFundingService.executeAtomicWalletCredit({
      flwId,
      txRef,
      amount: 5000,
      currency: "NGN",
      payloadData,
      explicitUserId: targetUid,
      source: "webhook",
    });

    expect(result.success).toBe(true);

    const ledgerDoc = await db.collection("transactions").doc(result.ledgerDocId).get();
    const storedData = ledgerDoc.data() || {};

    // Verify stored sender fields are null and did NOT leak wallet owner name or generic receiving bank
    expect(storedData.senderName).toBeNull();
    expect(storedData.senderBankName).toBeNull();
    expect(storedData.virtualAccountBankName).toBe("Wema Bank");
  });

  // Test H — Receiving bank remains separate from sender bank in ledger
  it("Test H: Receiving bank (virtualAccountBankName: Wema Bank) exists while senderBankName is null", async () => {
    const targetUid = "test-user-boundary-456";
    const flwId = "flw-boundary-test-888";
    const txRef = `flw-tx-${targetUid}-2002`;

    const db = adminDb!;
    await db.collection("users").doc(targetUid).set({ balance: 0, email: "boundary2@example.com" });

    const payloadData = {
      amount: 2500,
      bank_name: "Wema Bank",
      virtual_account_bank: "Wema Bank",
      virtual_account_number: "9988776655",
      meta_data: {
        originatorname: "AUTHORITATIVE SENDER",
        originatorbankname: "GTBank",
      },
    };

    const result = await WalletFundingService.executeAtomicWalletCredit({
      flwId,
      txRef,
      amount: 2500,
      currency: "NGN",
      payloadData,
      explicitUserId: targetUid,
      source: "webhook",
    });

    expect(result.success).toBe(true);

    const ledgerDoc = await db.collection("transactions").doc(result.ledgerDocId).get();
    const storedData = ledgerDoc.data() || {};

    expect(storedData.senderName).toBe("AUTHORITATIVE SENDER");
    expect(storedData.senderBankName).toBe("GTBank");
    expect(storedData.virtualAccountBankName).toBe("Wema Bank");
    expect(storedData.senderBankName).not.toBe("Wema Bank");
  });
});
