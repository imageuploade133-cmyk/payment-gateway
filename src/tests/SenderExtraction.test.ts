import { extractSenderInfo } from "../utils/senderExtractor";

describe("Sender Extractor Utility & Safety Rules", () => {
  // Test 1 — Real Flutterwave originator
  it("Test 1: should extract real Flutterwave originator fields from meta_data", () => {
    const payload = {
      data: {
        meta_data: {
          originatorname: "REAL SENDER NAME",
          bankname: "REAL SENDER BANK",
          originatoraccountnumber: "1234567890",
        },
        customer: {
          name: "RECIPIENT CUSTOMER NAME",
        },
      },
    };

    const sender = extractSenderInfo(payload.data);
    expect(sender.senderName).toBe("REAL SENDER NAME");
    expect(sender.senderBankName).toBe("REAL SENDER BANK");
    expect(sender.senderAccountNumber).toBe("1234567890");
  });

  // Test 2 — Generic recipient fields must NOT become sender
  it("Test 2: should NOT mistake generic recipient/virtual-account fields or customer.name for sender", () => {
    const payload = {
      amount: 10000,
      account_name: "E-GLOBAL VIRTUAL ACCOUNT (RECIPIENT)",
      account_number: "9988776655",
      bank_name: "Wema Bank",
      customer: {
        name: "RECIPIENT USER NAME",
      },
    };

    const sender = extractSenderInfo(payload);
    expect(sender.senderName).toBeNull();
    expect(sender.senderAccountNumber).toBeNull();
    expect(sender.senderName).not.toBe("E-GLOBAL VIRTUAL ACCOUNT (RECIPIENT)");
    expect(sender.senderName).not.toBe("RECIPIENT USER NAME");
  });

  // Test 3 — Explicit sender fields
  it("Test 3: should extract explicitly supported originator fields (originator_name, sender_name)", () => {
    const payload1 = {
      originator_name: "KABIRU SHABA",
      originator_bank: "GTBANK",
      originator_account_number: "0123456789",
    };

    const sender1 = extractSenderInfo(payload1);
    expect(sender1.senderName).toBe("KABIRU SHABA");
    expect(sender1.senderBankName).toBe("GTBANK");
    expect(sender1.senderAccountNumber).toBe("0123456789");

    const payload2 = {
      sender_name: "CHINEDU OKONKWO",
      sender_bank: "ZENITH BANK",
      sender_account: "0987654321",
    };

    const sender2 = extractSenderInfo(payload2);
    expect(sender2.senderName).toBe("CHINEDU OKONKWO");
    expect(sender2.senderBankName).toBe("ZENITH BANK");
    expect(sender2.senderAccountNumber).toBe("0987654321");
  });

  // Test 4 — Existing sender preservation
  it("Test 4: should preserve existing valid sender when updating a transaction with missing/null payload sender info", () => {
    const existingData = {
      senderName: "ALREADY STORED SENDER",
      senderBankName: "STORED BANK",
      senderAccountNumber: "****6789",
      description: "Transfer From ALREADY STORED SENDER",
    };

    const newPayloadWithoutSender = {
      amount: 5000,
      customer: { name: "RECIPIENT NAME" },
    };

    const extracted = extractSenderInfo(newPayloadWithoutSender);

    // Resolution rule: extracted sender || existing sender || null
    const finalSenderName = extracted.senderName || existingData.senderName || null;
    const finalSenderBankName = extracted.senderBankName || existingData.senderBankName || null;
    const finalSenderAccountNumber = extracted.senderAccountNumber || existingData.senderAccountNumber || null;

    expect(finalSenderName).toBe("ALREADY STORED SENDER");
    expect(finalSenderBankName).toBe("STORED BANK");
    expect(finalSenderAccountNumber).toBe("****6789");
    expect(finalSenderName).not.toBe("RECIPIENT NAME");
  });

  // Test 5 — Webhook and verification consistency
  it("Test 5: should return identical sender extraction results for webhook and verification payloads", () => {
    const rawData = {
      amount: 25000,
      meta_data: {
        originatorname: "CONSISTENT SENDER",
        bankname: "FIRST BANK",
        originatoraccountnumber: "1122334455",
      },
      customer: {
        name: "CUSTOMER RECIPIENT",
      },
    };

    // Simulated webhook path input: payload.data
    const webhookSender = extractSenderInfo(rawData);

    // Simulated verification path input: result object containing same data
    const verificationSender = extractSenderInfo(rawData);

    expect(webhookSender).toEqual(verificationSender);
    expect(webhookSender.senderName).toBe("CONSISTENT SENDER");
    expect(verificationSender.senderName).toBe("CONSISTENT SENDER");
  });
});
