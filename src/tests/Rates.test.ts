import request from "supertest";
import app from "../app";
import { getFlutterwaveClient } from "../providers/flutterwave";

jest.mock("../providers/flutterwave");
const mockedGetClient = getFlutterwaveClient as jest.MockedFunction<typeof getFlutterwaveClient>;

describe("GET /api/flutterwave/rates VM Endpoint Tests", () => {
  let mockClient: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient = {
      request: jest.fn(),
    };
    mockedGetClient.mockReturnValue(mockClient);
  });

  const S2S_HEADERS = {
    "x-api-key": process.env.PAYMENT_GATEWAY_API_KEY || "default_gateway_secure_key_12345",
  };

  it("should return normalized live rates for USD -> NGN", async () => {
    mockClient.request.mockResolvedValueOnce({
      status: "success",
      message: "Transfer rate fetched",
      data: {
        rate: 1364.225,
        source: { currency: "USD", amount: 1 },
        destination: { currency: "NGN", amount: 1364.225 },
      },
    });

    const res = await request(app)
      .get("/api/flutterwave/rates?sourceCurrency=USD&destinationCurrency=NGN&amount=1")
      .set(S2S_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.provider).toBe("flutterwave");
    expect(res.body.sourceCurrency).toBe("USD");
    expect(res.body.destinationCurrency).toBe("NGN");
    expect(res.body.rate).toBe(1364.225);
    expect(res.body.sourceAmount).toBe(1);
    expect(res.body.destinationAmount).toBe(1364.225);
    expect(res.body.fetchedAt).toBeDefined();
    expect(res.body.secretKey).toBeUndefined();
  });

  it("should return normalized live rates for NGN -> USD", async () => {
    mockClient.request.mockResolvedValueOnce({
      status: "success",
      message: "Transfer rate fetched",
      data: {
        rate: 0.000732,
        source: { currency: "NGN", amount: 1 },
        destination: { currency: "USD", amount: 0.000732 },
      },
    });

    const res = await request(app)
      .get("/api/flutterwave/rates?sourceCurrency=NGN&destinationCurrency=USD&amount=1")
      .set(S2S_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.sourceCurrency).toBe("NGN");
    expect(res.body.destinationCurrency).toBe("USD");
    expect(res.body.rate).toBe(0.000732);
  });

  it("should handle XOF -> NGN direct queries correctly", async () => {
    mockClient.request.mockResolvedValueOnce({
      status: "success",
      message: "Transfer rate fetched",
      data: {
        rate: 2.45,
        source: { currency: "XOF", amount: 1 },
        destination: { currency: "NGN", amount: 2.45 },
      },
    });

    const res = await request(app)
      .get("/api/flutterwave/rates?sourceCurrency=XOF&destinationCurrency=NGN&amount=1")
      .set(S2S_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.sourceCurrency).toBe("XOF");
    expect(res.body.destinationCurrency).toBe("NGN");
    expect(res.body.rate).toBe(2.45);
  });

  it("should handle NGN -> XOF direct queries correctly", async () => {
    mockClient.request.mockResolvedValueOnce({
      status: "success",
      message: "Transfer rate fetched",
      data: {
        rate: 0.408,
        source: { currency: "NGN", amount: 1 },
        destination: { currency: "XOF", amount: 0.408 },
      },
    });

    const res = await request(app)
      .get("/api/flutterwave/rates?sourceCurrency=NGN&destinationCurrency=XOF&amount=1")
      .set(S2S_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.sourceCurrency).toBe("NGN");
    expect(res.body.destinationCurrency).toBe("XOF");
    expect(res.body.rate).toBe(0.408);
  });

  it("should handle USD -> XOF direct queries correctly", async () => {
    mockClient.request.mockResolvedValueOnce({
      status: "success",
      message: "Transfer rate fetched",
      data: {
        rate: 556.8,
        source: { currency: "USD", amount: 1 },
        destination: { currency: "XOF", amount: 556.8 },
      },
    });

    const res = await request(app)
      .get("/api/flutterwave/rates?sourceCurrency=USD&destinationCurrency=XOF&amount=1")
      .set(S2S_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.sourceCurrency).toBe("USD");
    expect(res.body.destinationCurrency).toBe("XOF");
    expect(res.body.rate).toBe(556.8);
  });

  it("should handle XOF -> USD direct queries correctly", async () => {
    mockClient.request.mockResolvedValueOnce({
      status: "success",
      message: "Transfer rate fetched",
      data: {
        rate: 0.00179,
        source: { currency: "XOF", amount: 1 },
        destination: { currency: "USD", amount: 0.00179 },
      },
    });

    const res = await request(app)
      .get("/api/flutterwave/rates?sourceCurrency=XOF&destinationCurrency=USD&amount=1")
      .set(S2S_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.sourceCurrency).toBe("XOF");
    expect(res.body.destinationCurrency).toBe("USD");
    expect(res.body.rate).toBe(0.00179);
  });

  it("should reject invalid currency parameters", async () => {
    const res = await request(app)
      .get("/api/flutterwave/rates?sourceCurrency=EUR&destinationCurrency=NGN&amount=1")
      .set(S2S_HEADERS);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain("Invalid currency");
  });

  it("should reject request when source and destination currencies are identical", async () => {
    const res = await request(app)
      .get("/api/flutterwave/rates?sourceCurrency=NGN&destinationCurrency=NGN&amount=100")
      .set(S2S_HEADERS);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain("cannot be identical");
  });
});
