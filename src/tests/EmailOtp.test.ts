import { EmailOtpService } from "../services/emailOtpService";

describe("EmailOtpService test suite", () => {
  it("exports EmailOtpService class with sendPinResetOtp and verifyPinResetOtp methods", () => {
    expect(typeof EmailOtpService.sendPinResetOtp).toBe("function");
    expect(typeof EmailOtpService.verifyPinResetOtp).toBe("function");
  });
});
