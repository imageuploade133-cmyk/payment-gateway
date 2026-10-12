import { extractSenderInfo } from "../utils/senderExtractor";
import { WalletFundingService } from "../services/walletFundingService";
import { PaymentVerificationService } from "../services/paymentVerificationService";
import { adminDb } from "../config/firebase";

// Mock PaymentVerificationService
jest.mock("../services/paymentVerificationService", () => {
  return {
    PaymentVerificationService: {
      verifyTransaction: jest.fn(),
      verifyTransactionByReference: jest.fn(),
    },
  };
});

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
      update: async (docRef: any, data: any) => {
        const cur = (await docRef.get()).data() || {};
        const updated = { ...cur };
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === "object" && (v as any).operand !== undefined) {
            updated[k] = (Number(cur[k]) || 0) + Number((v as any).operand);
          } else {
            updated[k] = v;
          }
        }
        return docRef.set(updated, { merge: true });
      },
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

  // Test C — Generic metadata bank variants
  it("Test C: Generic metadata bank variants (bank_name, bankName, bank) must EACH result in senderBankName === null", () => {
    const genericVariants = ["bank_name", "bankName", "bank"];

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

  // Test 1-18 explicit requirements
  it("Test 1: meta_data.originatorname becomes senderName", () => {
    const res = extractSenderInfo({ meta_data: { originatorname: "Alice Smith" } });
    expect(res.senderName).toBe("Alice Smith");
  });

  it("Test 2: meta_data.bankname becomes senderBankName", () => {
    const res = extractSenderInfo({ meta_data: { bankname: "Zenith Bank" } });
    expect(res.senderBankName).toBe("Zenith Bank");
  });

  it("Test 3: meta_data.bankcode becomes senderBankCode", () => {
    const res = extractSenderInfo({ meta_data: { bankcode: "057" } });
    expect(res.senderBankCode).toBe("057");
  });

  it("Test 4: meta_data.originatoraccountnumber becomes senderAccountNumber", () => {
    const res = extractSenderInfo({ meta_data: { originatoraccountnumber: "0011223344" } });
    expect(res.senderAccountNumber).toBe("0011223344");
  });

  it("Test 5: Top-level data.bank_name = 'Wema Bank' must NOT become senderBankName", () => {
    const res = extractSenderInfo({ bank_name: "Wema Bank" });
    expect(res.senderBankName).toBeNull();
  });

  it("Test 6: Top-level data.bank = 'Wema Bank' must NOT become senderBankName", () => {
    const res = extractSenderInfo({ bank: "Wema Bank" });
    expect(res.senderBankName).toBeNull();
  });

  it("Test 7: Generic metadata meta_data.bank_name = 'Wema Bank' must NOT override explicit originator bank", () => {
    const res = extractSenderInfo({
      meta_data: {
        bank_name: "Wema Bank",
        originatorbankname: "GTBank"
      }
    });
    expect(res.senderBankName).toBe("GTBank");
  });

  it("Test 8: Customer/wallet-owner name must never become senderName", () => {
    const res = extractSenderInfo({
      customer: { name: "John Customer" },
      sender_name: "John Customer"
    });
    expect(res.senderName).toBeNull();
  });

  it("Test 9 & 10: Missing originator metadata triggers provider-verification enrichment & successful verification enriches sender info", async () => {
    const targetUid = "test-uid-verify-enrich";
    const flwId = "12345678";
    const txRef = `flw-tx-${targetUid}-8888`;

    const db = adminDb!;
    await db.collection("users").doc(targetUid).set({ balance: 0, email: "enrich@example.com" });

    (PaymentVerificationService.verifyTransaction as jest.Mock).mockResolvedValueOnce({
      success: true,
      rawTxData: {
        meta_data: {
          originatorname: "ENRICHED SENDER",
          originatorbankname: "FIRST BANK",
          originatoraccountnumber: "0099887766",
          bankcode: "011"
        }
      }
    });

    const result = await WalletFundingService.executeAtomicWalletCredit({
      flwId,
      txRef,
      amount: 1000,
      currency: "NGN",
      payloadData: { amount: 1000 },
      explicitUserId: targetUid,
      source: "webhook",
    });

    expect(PaymentVerificationService.verifyTransaction).toHaveBeenCalledWith({
      transaction_id: flwId,
      requestId: "enrichment-verify"
    });

    const ledgerDoc = await db.collection("transactions").doc(result.ledgerDocId).get();
    const storedData = ledgerDoc.data() || {};

    expect(storedData.senderName).toBe("ENRICHED SENDER");
    expect(storedData.senderBankName).toBe("FIRST BANK");
    expect(storedData.senderBankCode).toBe("011");
    expect(storedData.senderAccountNumber).toBe("0099887766");
  });

  it("Test 11: Failed provider verification must NOT break or duplicate wallet credit", async () => {
    const targetUid = "test-uid-failed-verify";
    const flwId = "87654321";
    const txRef = `flw-tx-${targetUid}-7777`;

    const db = adminDb!;
    await db.collection("users").doc(targetUid).set({ balance: 0, email: "failedverify@example.com" });

    (PaymentVerificationService.verifyTransaction as jest.Mock).mockRejectedValueOnce(new Error("Network timeout"));

    const result = await WalletFundingService.executeAtomicWalletCredit({
      flwId,
      txRef,
      amount: 2000,
      currency: "NGN",
      payloadData: { amount: 2000 },
      explicitUserId: targetUid,
      source: "webhook",
    });

    expect(result.success).toBe(true);
    expect(result.credited).toBe(true);

    const userDoc = await db.collection("users").doc(targetUid).get();
    expect(userDoc.data()?.balance).toBe(2000);
  });

  it("Test 12, 13, 14: Receiving virtual account info remains separate from sender and resolves from wallet_accounts/{uid}", async () => {
    const targetUid = "test-uid-receiving-va";
    const flwId = "55554444";
    const txRef = `flw-tx-${targetUid}-3333`;

    const db = adminDb!;
    await db.collection("users").doc(targetUid).set({ balance: 0, email: "va@example.com" });
    await db.collection("wallet_accounts").doc(targetUid).set({
      accountNumber: "9900112233",
      bankName: "Wema Bank",
      userId: targetUid
    });

    const result = await WalletFundingService.executeAtomicWalletCredit({
      flwId,
      txRef,
      amount: 3000,
      currency: "NGN",
      payloadData: {
        meta_data: {
          originatorname: "SENDER ALICE",
          originatorbankname: "GTBank"
        }
      },
      explicitUserId: targetUid,
      source: "webhook",
    });

    const ledgerDoc = await db.collection("transactions").doc(result.ledgerDocId).get();
    const storedData = ledgerDoc.data() || {};

    expect(storedData.senderName).toBe("SENDER ALICE");
    expect(storedData.senderBankName).toBe("GTBank");
    expect(storedData.virtualAccountBankName).toBe("Wema Bank");
    expect(storedData.virtualAccountNumber).toBe("****2233");
  });

  it("Test 15 & 16: Sender bank (GTBank) never becomes receiving bank, and receiving bank (Wema Bank) never becomes sender bank", async () => {
    const targetUid = "test-uid-bank-sep";
    const flwId = "99881122";
    const txRef = `flw-tx-${targetUid}-4444`;

    const db = adminDb!;
    await db.collection("users").doc(targetUid).set({ balance: 0, email: "sep@example.com" });
    await db.collection("wallet_accounts").doc(targetUid).set({
      accountNumber: "8877665544",
      bankName: "Wema Bank",
      userId: targetUid
    });

    const result = await WalletFundingService.executeAtomicWalletCredit({
      flwId,
      txRef,
      amount: 1500,
      currency: "NGN",
      payloadData: {
        meta_data: {
          originatorbankname: "GTBank"
        }
      },
      explicitUserId: targetUid,
      source: "webhook",
    });

    const ledgerDoc = await db.collection("transactions").doc(result.ledgerDocId).get();
    const storedData = ledgerDoc.data() || {};

    expect(storedData.senderBankName).toBe("GTBank");
    expect(storedData.virtualAccountBankName).toBe("Wema Bank");
    expect(storedData.senderBankName).not.toBe("Wema Bank");
    expect(storedData.virtualAccountBankName).not.toBe("GTBank");
  });

  it("Test 17: Existing atomic/idempotent funding behavior remains intact", async () => {
    const targetUid = "test-uid-idempotent";
    const flwId = "77665544";
    const txRef = `flw-tx-${targetUid}-5555`;

    const db = adminDb!;
    await db.collection("users").doc(targetUid).set({ balance: 0, email: "idem@example.com" });

    const first = await WalletFundingService.executeAtomicWalletCredit({
      flwId,
      txRef,
      amount: 5000,
      currency: "NGN",
      payloadData: { amount: 5000 },
      explicitUserId: targetUid,
      source: "webhook",
    });

    expect(first.credited).toBe(true);

    const second = await WalletFundingService.executeAtomicWalletCredit({
      flwId,
      txRef,
      amount: 5000,
      currency: "NGN",
      payloadData: { amount: 5000 },
      explicitUserId: targetUid,
      source: "webhook",
    });

    expect(second.alreadyCredited).toBe(true);
    expect(second.credited).toBe(false);

    const userDoc = await db.collection("users").doc(targetUid).get();
    expect(userDoc.data()?.balance).toBe(5000);
  });

  it("Test 20: Regression test - Unmasked sender account number with leading zero is preserved completely", async () => {
    const targetUid = "test-uid-leading-zero";
    const flwId = "1020304050";
    const txRef = `flw-tx-${targetUid}-9900`;

    const db = adminDb!;
    await db.collection("users").doc(targetUid).set({ balance: 0, email: "leadingzero@example.com" });

    const result = await WalletFundingService.executeAtomicWalletCredit({
      flwId,
      txRef,
      amount: 5000,
      currency: "NGN",
      payloadData: {
        meta_data: {
          originatorname: "SENDER WITH LEADING ZERO",
          originatorbankname: "GTBANK",
          originatoraccountnumber: "0123456789"
        }
      },
      explicitUserId: targetUid,
      source: "webhook",
    });

    expect(result.success).toBe(true);

    const ledgerDoc = await db.collection("transactions").doc(result.ledgerDocId).get();
    const storedData = ledgerDoc.data() || {};

    expect(storedData.senderAccountNumber).toBe("0123456789");
    expect(storedData.senderAccountNumber).toHaveLength(10);
    expect(storedData.senderAccountNumber?.startsWith("0")).toBe(true);
  });

  it("Test 18: Real Flutterwave transaction structure passes safely through the pipeline", async () => {
    const targetUid = "test-uid-real-struct";
    const flwId = "987654321";
    const txRef = `flw-tx-${targetUid}-6666`;

    const db = adminDb!;
    await db.collection("users").doc(targetUid).set({ balance: 0, email: "real@example.com" });
    await db.collection("wallet_accounts").doc(targetUid).set({
      accountNumber: "1122334455",
      bankName: "Wema Bank",
      userId: targetUid
    });

    const realFlwPayload = {
      id: 987654321,
      tx_ref: txRef,
      flw_ref: "FLW-MOCK-REF-12345",
      amount: 10000,
      currency: "NGN",
      status: "successful",
      payment_type: "bank_transfer",
      created_at: "2026-03-31T12:00:00.000Z",
      customer: {
        id: 12345,
        name: "Real Customer Name",
        email: "real@example.com"
      },
      meta_data: {
        originatorname: "AUTHORITATIVE EXTERNAL SENDER",
        bankname: "GUARANTY TRUST BANK",
        bankcode: "058",
        originatoraccountnumber: "0123456789"
      }
    };

    const result = await WalletFundingService.executeAtomicWalletCredit({
      flwId,
      txRef,
      amount: 10000,
      currency: "NGN",
      payloadData: realFlwPayload,
      explicitUserId: targetUid,
      source: "webhook",
    });

    expect(result.success).toBe(true);
    expect(result.credited).toBe(true);

    const ledgerDoc = await db.collection("transactions").doc(result.ledgerDocId).get();
    const storedData = ledgerDoc.data() || {};

    expect(storedData.senderName).toBe("AUTHORITATIVE EXTERNAL SENDER");
    expect(storedData.senderBankName).toBe("GUARANTY TRUST BANK");
    expect(storedData.senderBankCode).toBe("058");
    expect(storedData.senderAccountNumber).toBe("0123456789");
    expect(storedData.virtualAccountBankName).toBe("Wema Bank");
    expect(storedData.virtualAccountNumber).toBe("****4455");
    expect(storedData.status).toBe("SUCCESS");
    expect(storedData.credited).toBe(true);
  });
});
