export class PaystackError extends Error {
  public statusCode?: number;
  public errorCode?: string;
  public details?: any;

  constructor(message: string, statusCode?: number, errorCode?: string, details?: any) {
    super(message);
    this.name = "PaystackError";
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.details = details;
  }

  public static fromError(err: any): PaystackError {
    if (err instanceof PaystackError) {
      return err;
    }

    if (err.response) {
      const status = err.response.status;
      const data = err.response.data;
      const message = data?.message || `HTTP Error ${status}: ${err.response.statusText}`;
      const code = data?.code || "PAYSTACK_HTTP_ERROR";
      return new PaystackError(message, status, code, data);
    }

    if (err.request) {
      return new PaystackError(
        "No response received from Paystack. Network connection timed out or failed.",
        504,
        "PAYSTACK_GATEWAY_TIMEOUT"
      );
    }

    return new PaystackError(err.message || "An unexpected request setup error occurred.", 500, "PAYSTACK_CLIENT_ERROR");
  }
}
