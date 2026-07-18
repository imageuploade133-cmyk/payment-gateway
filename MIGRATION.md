# Migration Plan: Next.js Wallet Application to Secure Payment Gateway Microservice (REVISED)

## Overview
This document outlines the revised migration architecture for decomposing payment provider communications from the Next.js application (deployed on Vercel) into a standalone, production-ready **Payment Gateway Microservice** (deployed on Google Cloud VM with a static IP).

Following the architectural guidelines, **the Payment Gateway strictly owns payment-provider communication and provider-specific workflows**. The Next.js application remains the absolute source of truth for wallet balances, PIN validation, user permissions, transaction history, and core business rules.

```
Users ────> Next.js App (Vercel) ────> Payment Gateway (GCP VM with Static IP) ────> Payment Providers (Flutterwave/Paystack)
             (Balances, PINs, Logs)      (S2S Signed Proxy & Provider Wrappers)
```

---

## 1. Updated Architectural Boundaries

### Main Next.js Application (Source of Truth)
- **Wallet Balances**: Storage and mutations of wallet balances reside completely in Next.js Firestore collections.
- **PIN & Security Validation**: Checking and hashing of transaction PINs and lockouts are handled strictly inside Next.js API routes before calling the gateway.
- **Ledger & History Log**: Direct creation of consumer transaction records, user profile reads, and daily transfer limits enforcement remain inside Next.js.
- **Reconciliation/Refund rollback**: If a transfer or payment fails, Next.js handles refunding the user's wallet.

### Payment Gateway Microservice (Static IP Provider Bridge)
- **Direct Provider Connection**: Any HTTP request targeting `/payments`, `/accounts/resolve`, `/transfers`, `/bulk-transfers`, `/virtual-account-numbers` (Flutterwave) or `/transaction/initialize`, `/bank/resolve`, `/transfer` (Paystack).
- **Webhook Verifications**: Initial signature validation (`verif-hash` or `x-paystack-signature` verification). Once verified, the gateway forwards a verified payload to the Next.js app to trigger the corresponding balance updates.
- **Provider-specific formatting**: Maps standard payloads into provider schemas.

---

## 2. Updated File Inventory & Strategy

### Category A: Files to Move/Replicate into the Payment Gateway
These files handle third-party provider interactions, signatures, and low-level provider configurations.

| File Path in Existing Project | Description | Target Location in Payment Gateway | Why |
| :--- | :--- | :--- | :--- |
| `src/lib/flutterwave.ts` | Base API request helper for Flutterwave. | `src/providers/flutterwave/client.ts` | Handles direct HTTP traffic to Flutterwave. Must run from Whitelisted IP. |
| `src/lib/payment/providers/flutterwave/FlutterwaveGateway.ts` | Unified interface implementation for Flutterwave. | `src/providers/flutterwave/FlutterwaveGateway.ts` | Implements provider contract. |
| `src/lib/payment/providers/paystack/PaystackGateway.ts` | Unified interface implementation for Paystack. | `src/providers/paystack/PaystackGateway.ts` | Implements provider contract. |
| `src/lib/payment/PaymentGateway.ts` | Core TypeScript interfaces and types for providers. | `src/types/payment.ts` | Standardizes requests/responses. |
| `src/lib/payment/PaymentGatewayManager.ts` | Handles routing, priority, failover. | `src/services/PaymentGatewayManager.ts` | Gateway-wide multi-provider orchestration. |
| `src/lib/firebase-admin.ts` | Server-side Firebase Admin SDK init. | `src/config/firebase.ts` | Used for configuration parameters and server logs. |

### Category B: Files to REMAIN inside Next.js (Vercel)
These files govern the core user state, PIN security, and ledger balances.

| File Path in Existing Project | Description | Action | Why |
| :--- | :--- | :--- | :--- |
| `src/services/wallet-service.ts` | Atomic ledger updates (credit, debit, validation). | **Remain** | Next.js remains the source of truth for wallet balance mutations. |
| `src/services/virtual-account-service.ts`| Creates/saves virtual account to database. | **Remain** | The database saving logic remains in Next.js; the microservice strictly handles the HTTP call to Flutterwave. |
| `src/services/bulk-transfer-service.ts` | Database batch queuing and logic. | **Remain** | Keeps database state in Next.js; microservice strictly dispatches API batch. |
| `src/services/transfer-recovery-service.ts` | Background scanner checking status of processing transactions. | **Remain** | Connects to DB state to execute refund reversals in Next.js. |
| `src/lib/wallet-funding.ts` | Payment verification and atomic wallet crediting. | **Remain** | Keeps credit balance transactions in Next.js. |

---

## 3. Stable API Surface (Payment Gateway Router)

The Payment Gateway exposes a secure, stable API surface to Next.js.

### System & Health
- `GET /health` - Service health monitor.

### Flutterwave Provider Endpoints
- `POST /api/flutterwave/resolve-account` - Verifies bank account details.
- `POST /api/flutterwave/transfer` - Dispatches single outward bank transfers.
- `POST /api/flutterwave/bulk-transfer` - Dispatches batch bank transfers.
- `POST /api/flutterwave/create-virtual-account` - Allocates a permanent virtual account.
- `POST /api/flutterwave/verify` - Verifies a payment reference with Flutterwave.
- `POST /api/flutterwave/webhook` - Standard Flutterwave transaction webhooks.

### Paystack Provider Endpoints
- `POST /api/paystack/initialize` - Initializes a Paystack checkout transaction.
- `POST /api/paystack/verify` - Verifies a payment reference with Paystack.
- `POST /api/paystack/webhook` - Standard Paystack webhooks.
