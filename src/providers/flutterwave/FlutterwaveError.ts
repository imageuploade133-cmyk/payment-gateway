export class FlutterwaveError extends Error {
  public statusCode?: number;
  public errorCode?: string;
  public details?: any;

  constructor(message: string, statusCode?: number, errorCode?: string, details?: any) {
    super(message);
    this.name = "FlutterwaveError";
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.details = details;
  }

  public static fromError(err: any): FlutterwaveError {
    if (err instanceof FlutterwaveError) {
      return err;
    }

    if (err.response) {
      // The request was made and the server responded with a status code
      const status = err.response.status;
      const data = err.response.data;
      const message = data?.message || `HTTP Error ${status}: ${err.response.statusText}`;
      const code = data?.code || "FLW_HTTP_ERROR";
      return new FlutterwaveError(message, status, code, data);
    }

    if (err.request) {
      // The request was made but no response was received
      return new FlutterwaveError(
        "No response received from Flutterwave. Network connection timed out or failed.",
        504,
        "FLW_GATEWAY_TIMEOUT"
      );
    }

    // Something happened in setting up the request that triggered an Error
    return new FlutterwaveError(err.message || "An unexpected request setup error occurred.", 500, "FLW_CLIENT_ERROR");
  }
}
