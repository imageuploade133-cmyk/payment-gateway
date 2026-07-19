import { FirestoreIdempotency } from "../services/firestoreIdempotency";
import { initializeFirebaseAdmin } from "../config/firebase";

// Mock Firebase Admin SDK
jest.mock("firebase-admin/app", () => ({
  getApps: jest.fn(() => []),
  initializeApp: jest.fn(),
  cert: jest.fn(),
}));

jest.mock("firebase-admin/firestore", () => ({
  getFirestore: jest.fn(() => ({
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({
        get: jest.fn(),
        set: jest.fn(),
      })),
    })),
  })),
}));

describe("Firebase Admin & Idempotency Integration Tests (Phase 7)", () => {
  describe("Firebase Initialization Fallbacks", () => {
    it("should gracefully handle missing credentials by returning offline states rather than crashing", () => {
      // Clear environment variables temporarily
      const prevProject = process.env.FIREBASE_PROJECT_ID;
      const prevEmail = process.env.FIREBASE_CLIENT_EMAIL;
      delete process.env.FIREBASE_PROJECT_ID;
      delete process.env.FIREBASE_CLIENT_EMAIL;

      const result = initializeFirebaseAdmin();
      expect(result.hasCredentials).toBe(false);
      expect(result.db).toBeNull();

      // Restore environment
      process.env.FIREBASE_PROJECT_ID = prevProject;
      process.env.FIREBASE_CLIENT_EMAIL = prevEmail;
    });
  });

  describe("Firestore-Backed Idempotency Provider", () => {
    it("should instantiate as a singleton correctly", () => {
      const instance1 = FirestoreIdempotency.getInstance();
      const instance2 = FirestoreIdempotency.getInstance();
      expect(instance1).toBe(instance2);
    });

    it("should fall back gracefully to memory cache if Firestore is not loaded/fails", async () => {
      const idempotency = FirestoreIdempotency.getInstance();
      const ref = `fall-test-${Date.now()}`;

      // Verify that it can save and detect duplicate without throwing, even if Firestore is offline
      await idempotency.saveReference(ref, "flutterwave");
      const isDup = await idempotency.isDuplicate(ref);
      expect(isDup).toBe(true);
    });

    it("should support webhook processed marking and duplication detection", async () => {
      const idempotency = FirestoreIdempotency.getInstance();
      const webhookId = `wh-id-998877`;

      await idempotency.saveWebhookProcessed(webhookId, "charge.completed");
      const isDup = await idempotency.isWebhookDuplicate(webhookId);
      expect(isDup).toBe(true);
    });
  });
});
