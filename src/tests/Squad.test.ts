import axios from "axios";
import { SquadService } from "../services/squadService";
import { env } from "../config/env";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe("SquadService Unit Tests", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    env.SQUAD_BENEFICIARY_ACCOUNT = "0123456789";
  });

  it("should successfully extract account number from virtual_account_number when Squad API succeeds", async () => {
    mockedAxios.post.mockResolvedValueOnce({
      status: 200,
      data: {
        success: true,
        message: "Success",
        data: {
          first_name: "John",
          last_name: "Doe",
          bank_code: "058",
          bank_name: "Guaranty Trust Bank",
          virtual_account_number: "1234567890",
          beneficiary_account: "0123456789",
          customer_identifier: "cust-1",
        },
      },
    });

    const result = await SquadService.createVirtualAccount({
      email: "john@example.com",
      firstName: "John",
      lastName: "Doe",
      phone: "08012345678",
      bvn: "12345678901",
      customer_identifier: "cust-1",
      requestId: "req-1",
    });

    expect(result.success).toBe(true);
    expect(result.account_number).toBe("1234567890");
    expect(result.bank_name).toBe("Guaranty Trust Bank");
  });

  it("should fail gracefully if virtual_account_number is missing in successful API response", async () => {
    mockedAxios.post.mockResolvedValueOnce({
      status: 200,
      data: {
        success: true,
        message: "Success",
        data: {
          first_name: "John",
          last_name: "Doe",
          bank_code: "058",
        },
      },
    });

    const result = await SquadService.createVirtualAccount({
      email: "john@example.com",
      firstName: "John",
      lastName: "Doe",
      phone: "08012345678",
      bvn: "12345678901",
      customer_identifier: "cust-1",
      requestId: "req-1",
    });

    expect(result.success).toBe(false);
    expect(result.account_number).toBe("");
    expect(result.message).toContain("did not contain a valid virtual account number");
  });

  it("should fail gracefully if virtual_account_number is empty string in successful API response", async () => {
    mockedAxios.post.mockResolvedValueOnce({
      status: 200,
      data: {
        success: true,
        message: "Success",
        data: {
          first_name: "John",
          last_name: "Doe",
          bank_code: "058",
          virtual_account_number: "   ",
        },
      },
    });

    const result = await SquadService.createVirtualAccount({
      email: "john@example.com",
      firstName: "John",
      lastName: "Doe",
      phone: "08012345678",
      bvn: "12345678901",
      customer_identifier: "cust-1",
      requestId: "req-1",
    });

    expect(result.success).toBe(false);
    expect(result.account_number).toBe("");
    expect(result.message).toContain("did not contain a valid virtual account number");
  });
});
