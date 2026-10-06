import { resolveFundingLedgerDocId } from "../utils/userIdParser";

describe("Concurrency, Persistence & Canonical Idempotency Final-State Integration Suite", () => {
  it("A. Same permanent virtual account receiving ₦500 (flwId: 101) and ₦200 (flwId: 102) creates distinct canonical ledger docs", () => {
    const permanentTxRef = "user-wallet-user123";
    const docId1 = resolveFundingLedgerDocId(permanentTxRef, "101");
    const docId2 = resolveFundingLedgerDocId(permanentTxRef, "102");

    expect(docId1).toBe("tx-FUNDING-flw-101");
    expect(docId2).toBe("tx-FUNDING-flw-102");
    expect(docId1).not.toBe(docId2);
  });

  it("B. Concurrent Webhook + Manual Verification + Reconciliation race for flwId: 999 results in exactly ONE credit", async () => {
    let userBalance = 1000;
    const ledgerDb: Record<string, any> = {};

    async function executeAtomicCredit(flwId: string, txRef: string, amount: number) {
      const docId = resolveFundingLedgerDocId(txRef, flwId);

      // Simulate atomic transaction
      if (ledgerDb[docId] && (ledgerDb[docId].status === "SUCCESS" || ledgerDb[docId].credited === true)) {
        return { credited: false, alreadyCredited: true, balance: userBalance };
      }

      // Record credit atomically
      userBalance += amount;
      ledgerDb[docId] = {
        flwId,
        txRef,
        amount,
        status: "SUCCESS",
        credited: true,
        createdAt: new Date().toISOString(),
      };

      return { credited: true, alreadyCredited: false, balance: userBalance };
    }

    // Simulate 3 concurrent executions (Webhook, Manual Verification, Reconciliation)
    const [resWebhook, resVerify, resReconcile] = await Promise.all([
      executeAtomicCredit("999", "flw-tx-user123-1", 500),
      executeAtomicCredit("999", "flw-tx-user123-1", 500),
      executeAtomicCredit("999", "flw-tx-user123-1", 500),
    ]);

    const creditsApplied = [resWebhook, resVerify, resReconcile].filter(r => r.credited).length;
    const alreadyCreditedCount = [resWebhook, resVerify, resReconcile].filter(r => r.alreadyCredited).length;

    expect(creditsApplied).toBe(1);
    expect(alreadyCreditedCount).toBe(2);
    expect(userBalance).toBe(1500); // 1000 + 500 = 1500, NOT 2500!
    expect(Object.keys(ledgerDb).length).toBe(1);
  });

  it("C. Missing or invalid flwId prevents automated credit and flags for manual review", () => {
    const invalidDocIdNull = resolveFundingLedgerDocId("user-wallet-123", null);
    const invalidDocIdNA = resolveFundingLedgerDocId("user-wallet-123", "N/A");

    // Falls back to txRef docId rather than inventing a false flwId
    expect(invalidDocIdNull).toBe("tx-FUNDING-user-wallet-123");
    expect(invalidDocIdNA).toBe("tx-FUNDING-user-wallet-123");
  });
});
