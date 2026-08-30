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

  it("should return normalized live rates for GHS -> NGN", async () => {
    mockClient.request.mockResolvedValueOnce({
      status: "success",
      message: "Transfer rate fetched",
      data: {
        rate: 88.5,
        source: { currency: "GHS", amount: 1 },
        destination: { currency: "NGN", amount: 88.5 },
      },
    });

    const res = await request(app)
      .get("/api/flutterwave/rates?sourceCurrency=GHS&destinationCurrency=NGN&amount=1")
      .set(S2S_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.sourceCurrency).toBe("GHS");
    expect(res.body.destinationCurrency).toBe("NGN");
    expect(res.body.rate).toBe(88.5);
  });

  it("should return normalized live rates for KES -> NGN", async () => {
    mockClient.request.mockResolvedValueOnce({
      status: "success",
      message: "Transfer rate fetched",
      data: {
        rate: 10.2,
        source: { currency: "KES", amount: 1 },
        destination: { currency: "NGN", amount: 10.2 },
      },
    });

    const res = await request(app)
      .get("/api/flutterwave/rates?sourceCurrency=KES&destinationCurrency=NGN&amount=1")
      .set(S2S_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.sourceCurrency).toBe("KES");
    expect(res.body.destinationCurrency).toBe("NGN");
    expect(res.body.rate).toBe(10.2);
  });

  it("should return normalized live rates for GBP -> NGN", async () => {
    mockClient.request.mockResolvedValueOnce({
      status: "success",
      message: "Transfer rate fetched",
      data: {
        rate: 1720.5,
        source: { currency: "GBP", amount: 1 },
        destination: { currency: "NGN", amount: 1720.5 },
      },
    });

    const res = await request(app)
      .get("/api/flutterwave/rates?sourceCurrency=GBP&destinationCurrency=NGN&amount=1")
      .set(S2S_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.sourceCurrency).toBe("GBP");
    expect(res.body.destinationCurrency).toBe("NGN");
    expect(res.body.rate).toBe(1720.5);
  });

  it("should return normalized live rates for EUR -> NGN", async () => {
    mockClient.request.mockResolvedValueOnce({
      status: "success",
      message: "Transfer rate fetched",
      data: {
        rate: 1480.25,
        source: { currency: "EUR", amount: 1 },
        destination: { currency: "NGN", amount: 1480.25 },
      },
    });

    const res = await request(app)
      .get("/api/flutterwave/rates?sourceCurrency=EUR&destinationCurrency=NGN&amount=1")
      .set(S2S_HEADERS);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.sourceCurrency).toBe("EUR");
    expect(res.body.destinationCurrency).toBe("NGN");
    expect(res.body.rate).toBe(1480.25);
  });

  it("should reject invalid unsupported currency parameters", async () => {
    const res = await request(app)
      .get("/api/flutterwave/rates?sourceCurrency=XYZ&destinationCurrency=NGN&amount=1")
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
