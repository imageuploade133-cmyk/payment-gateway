import { extractSenderInfo } from "../utils/senderExtractor";

describe("Sender Extractor Utility", () => {
  it("should extract sender info from meta_data object (case insensitive)", () => {
    const payload = {
      amount: 5000,
      currency: "NGN",
      meta_data: {
        OriginatorName: "KABIRU ABDULLAHI SHABA",
        BankName: "GTBANK",
        OriginatorAccountNumber: "0123456789",
      },
      customer: {
        name: "E-Global Tech Customer",
      },
    };

    const sender = extractSenderInfo(payload);
    expect(sender.senderName).toBe("KABIRU ABDULLAHI SHABA");
    expect(sender.senderBankName).toBe("GTBANK");
    expect(sender.senderAccountNumber).toBe("0123456789");
  });

  it("should extract sender info from top-level fields", () => {
    const payload = {
      originatorname: "CHINEDU OKONKWO",
      originatorbankname: "ACCESS BANK",
      originatoraccountnumber: "0987654321",
      customer: {
        name: "E-Global Tech Customer",
      },
    };

    const sender = extractSenderInfo(payload);
    expect(sender.senderName).toBe("CHINEDU OKONKWO");
    expect(sender.senderBankName).toBe("ACCESS BANK");
    expect(sender.senderAccountNumber).toBe("0987654321");
  });

  it("should extract sender info from nested meta array or object", () => {
    const payload = {
      meta: [
        { Metaname: "originator_name", Metavalue: "AISHAT MOHAMMED" },
        { Metaname: "originator_bank", Metavalue: "ZENITH BANK" },
        { Metaname: "originator_account_number", Metavalue: "2233445566" },
      ],
      customer: {
        name: "Recipient Customer Name",
      },
    };

    const sender = extractSenderInfo(payload);
    expect(sender.senderName).toBe("AISHAT MOHAMMED");
    expect(sender.senderBankName).toBe("ZENITH BANK");
    expect(sender.senderAccountNumber).toBe("2233445566");
  });

  it("should ignore customer.name when no originator fields are found", () => {
    const payload = {
      amount: 1000,
      customer: {
        name: "John Doe (Recipient)",
      },
    };

    const sender = extractSenderInfo(payload);
    expect(sender.senderName).toBeNull();
    expect(sender.senderBankName).toBeNull();
    expect(sender.senderAccountNumber).toBeNull();
  });

  it("should clean up null, N/A or empty values", () => {
    const payload = {
      meta_data: {
        originatorname: "N/A",
        bankname: "null",
        originatoraccountnumber: "",
      },
    };

    const sender = extractSenderInfo(payload);
    expect(sender.senderName).toBeNull();
    expect(sender.senderBankName).toBeNull();
    expect(sender.senderAccountNumber).toBeNull();
  });
});
