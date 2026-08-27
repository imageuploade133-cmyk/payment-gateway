export interface EmailOtpSession {
    uid: string;
    email: string;
    hashedOtp: string;
    type: string;
    channel: string;
    verified: boolean;
    attempts: number;
    createdAt: string;
    expiresAt: string;
    cooldownUntil: string;
}
export declare class EmailOtpService {
    /**
     * Generates a cryptographically secure 6-digit OTP string
     */
    private static generateOtp;
    /**
     * Sends a PIN Reset OTP via the external Email API to the user's registered email.
     */
    static sendPinResetOtp(uid: string, authEmail?: string): Promise<{
        message: string;
        devOtp?: string;
    }>;
    /**
     * Verifies an Email PIN Reset OTP code submitted by the user.
     */
    static verifyPinResetOtp(uid: string, otpCode: string): Promise<{
        success: boolean;
        message: string;
    }>;
}
