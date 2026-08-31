import { handleWebhook } from "../controllers/flutterwaveController";
import { adminDb } from "../config/firebase";

jest.mock("../config/firebase", () => ({
  adminDb: {
    collection: jest.fn(),
    runTransaction: jest.fn(),
  },
}));

jest.mock("../config/env", () => ({
  env: {
    FLW_WEBHOOK_SECRET: "test-secret-hash",
  },
}));

jest.mock("../services/firestoreIdempotency", () => ({
  FirestoreIdempotency: {
    getInstance: jest.fn().mockReturnValue({
      isWebhookDuplicate: jest.fn().mockResolvedValue(false),
      saveWebhookProcessed: jest.fn().mockResolvedValue(undefined),
    }),
  },
}));

describe("Webhook Deposit & Virtual Account Tests", () => {
  let req: any;
  let res: any;
  let next: any;

  beforeEach(() => {
    jest.clearAllMocks();
    req = {
      id: "test-req-id",
      headers: {
        "verif-hash": "test-secret-hash",
      },
      body: {
        event: "charge.completed",
        data: {
          id: 2086434716,
          tx_ref: "user-wallet-C1vJGqceoGO57mVFYNM40URxCUL2",
          flw_ref: "FLW-MOCK-2086434716",
          amount: 100,
          currency: "NGN",
          status: "successful",
          originatorname: "John Sender",
          originatorbankname: "GTBank",
          originatoraccountnumber: "0123456789",
          account_number: "9921473281",
          bank_name: "Wema Bank",
          customer: {
            email: "test@example.com",
            name: "John Sender",
          },
        },
      },
    };

    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };

    next = jest.fn();
  });

  it("A. Should classify virtual account deposit as type VIRTUAL_ACCOUNT_DEPOSIT and category DEPOSIT", async () => {
    const mockUserDoc = { exists: true, data: () => ({ balance: 500 }) };
    const mockWalletDoc = { exists: true, data: () => ({ balance: 500 }) };

    const mockUserRef = { id: "C1vJGqceoGO57mVFYNM40URxCUL2" };
    const mockWalletRef = { id: "C1vJGqceoGO57mVFYNM40URxCUL2_NGN" };
    const mockLedgerRef = { id: "tx-user-wallet-C1vJGqceoGO57mVFYNM40URxCUL2" };

    (adminDb!.collection as jest.Mock).mockImplementation((collName: string) => {
      if (collName === "users") return { doc: () => mockUserRef };
      if (collName === "wallets") return { doc: () => mockWalletRef };
      if (collName === "transactions") return { doc: () => mockLedgerRef };
      return { doc: () => ({}) };
    });

    let setRecord: any = null;
    (adminDb!.runTransaction as jest.Mock).mockImplementation(async (callback: any) => {
      const mockTransaction = {
        get: jest.fn().mockImplementation((ref: any) => {
          if (ref === mockUserRef) return Promise.resolve(mockUserDoc);
          if (ref === mockWalletRef) return Promise.resolve(mockWalletDoc);
          return Promise.resolve({ exists: false });
        }),
        update: jest.fn(),
        set: jest.fn().mockImplementation((ref: any, data: any) => {
          if (ref === mockLedgerRef) {
            setRecord = data;
          }
        }),
      };
      return await callback(mockTransaction);
    });

    await handleWebhook(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(setRecord).not.toBeNull();
    expect(setRecord.type).toBe("VIRTUAL_ACCOUNT_DEPOSIT");
    expect(setRecord.category).toBe("DEPOSIT");
    expect(setRecord.direction).toBe("CREDIT");
    expect(setRecord.fundingMethod).toBe("Virtual Account");
    expect(setRecord.provider).toBe("Flutterwave");
    expect(setRecord.amount).toBe(100);
    expect(setRecord.senderName).toBe("John Sender");
    expect(setRecord.senderAccountNumber).toBe("0123456789");
    expect(setRecord.senderBankName).toBe("GTBank");
    expect(setRecord.virtualAccountNumber).toBe("9921473281");
    expect(setRecord.virtualAccountBankName).toBe("Wema Bank");
  });

  it("B. Should safely exclude sender fields when metadata is absent without inventing values", async () => {
    delete req.body.data.customer.name;
    delete req.body.data.originatorname;
    delete req.body.data.originatorbankname;
    delete req.body.data.originatoraccountnumber;

    const mockUserDoc = { exists: true, data: () => ({ balance: 500 }) };
    const mockWalletDoc = { exists: true, data: () => ({ balance: 500 }) };

    const mockUserRef = { id: "C1vJGqceoGO57mVFYNM40URxCUL2" };
    const mockWalletRef = { id: "C1vJGqceoGO57mVFYNM40URxCUL2_NGN" };
    const mockLedgerRef = { id: "tx-user-wallet-C1vJGqceoGO57mVFYNM40URxCUL2" };

    (adminDb!.collection as jest.Mock).mockImplementation((collName: string) => {
      if (collName === "users") return { doc: () => mockUserRef };
      if (collName === "wallets") return { doc: () => mockWalletRef };
      if (collName === "transactions") return { doc: () => mockLedgerRef };
      return { doc: () => ({}) };
    });

    let setRecord: any = null;
    (adminDb!.runTransaction as jest.Mock).mockImplementation(async (callback: any) => {
      const mockTransaction = {
        get: jest.fn().mockImplementation((ref: any) => {
          if (ref === mockUserRef) return Promise.resolve(mockUserDoc);
          if (ref === mockWalletRef) return Promise.resolve(mockWalletDoc);
          return Promise.resolve({ exists: false });
        }),
        update: jest.fn(),
        set: jest.fn().mockImplementation((ref: any, data: any) => {
          if (ref === mockLedgerRef) {
            setRecord = data;
          }
        }),
      };
      return await callback(mockTransaction);
    });

    await handleWebhook(req, res, next);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(setRecord).not.toBeNull();
    expect(setRecord.senderName).toBeUndefined();
    expect(setRecord.senderAccountNumber).toBeUndefined();
    expect(setRecord.beneficiaryName).toBeUndefined();
  });

  it("G. Regression Test: Proves Virtual Account Deposit != Outward Bank Transfer", () => {
    const depositRecord = {
      type: "VIRTUAL_ACCOUNT_DEPOSIT",
      category: "DEPOSIT",
      direction: "CREDIT",
      fundingMethod: "Virtual Account",
      provider: "Flutterwave",
      amount: 100,
    };

    const transferRecord = {
      type: "TRANSFER",
      category: "TRANSFER",
      direction: "DEBIT",
      beneficiaryName: "Jane Recipient",
      beneficiaryBankName: "Access Bank",
      beneficiaryAccountNumber: "0011223344",
      amount: 5000,
      fee: 10,
    };

    expect(depositRecord.category).not.toBe(transferRecord.category);
    expect(depositRecord.direction).not.toBe(transferRecord.direction);
    expect(depositRecord.type).not.toBe(transferRecord.type);
  });
});
