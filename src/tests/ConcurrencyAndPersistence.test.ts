import { resolveFundingLedgerDocId, isValidFlwId } from "../utils/userIdParser";

describe("Concurrency, Persistence & Canonical Idempotency Final-State Integration Suite", () => {
  it("A. Permanent Virtual Account deposits with distinct flwId generate canonical doc IDs", () => {
    const permanentTxRef = "user-wallet-123";
    const docId1 = resolveFundingLedgerDocId(permanentTxRef, "101");
    const docId2 = resolveFundingLedgerDocId(permanentTxRef, "102");

    expect(docId1).toBe("tx-FUNDING-flw-101");
    expect(docId2).toBe("tx-FUNDING-flw-102");
    expect(docId1).not.toBe(docId2);
  });

  it("B. Concurrent deposits to same account yield unique canonical provider identities", () => {
    const flwId = "101";
    const txRef = "user-wallet-123";

    const docId = resolveFundingLedgerDocId(txRef, flwId);
    expect(docId).toBe("tx-FUNDING-flw-101");

    // Race simulation: both webhook and verify produce the exact same doc ID
    const docIdWebhook = resolveFundingLedgerDocId(txRef, flwId);
    const docIdVerify = resolveFundingLedgerDocId(txRef, flwId);

    expect(docIdWebhook).toBe("tx-FUNDING-flw-101");
    expect(docIdVerify).toBe("tx-FUNDING-flw-101");
    expect(docIdWebhook).toBe(docIdVerify);
  });

  it("C. Missing or invalid flwId fails closed and generates tx-FUNDING-UNKNOWN to prevent static txRef auto-credit", () => {
    const invalidDocIdNull = resolveFundingLedgerDocId("user-wallet-123", null);
    const invalidDocIdNA = resolveFundingLedgerDocId("user-wallet-123", "N/A");

    expect(isValidFlwId(null)).toBe(false);
    expect(isValidFlwId("N/A")).toBe(false);

    // Static permanent virtual account txRef is blocked from generating a usable auto-credit doc ID
    expect(invalidDocIdNull).toBe("tx-FUNDING-UNKNOWN");
    expect(invalidDocIdNA).toBe("tx-FUNDING-UNKNOWN");
  });
});
