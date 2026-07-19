# Payment Gateway Microservice

A production-ready, enterprise-grade payment gateway microservice designed to act as a secure bridge between the E-Tech Wallet Next.js application (on Vercel) and payment providers (Flutterwave, Paystack, etc.).

This microservice runs on a Google Cloud VM with a Static IP to fulfill IP whitelisting requirements of payment providers.

---

## Technical Stack
- **Node.js 22 LTS**
- **TypeScript**
- **Express.js**
- **Firebase Admin SDK** (Firestore-backed idempotency & transaction audit logs)
- **Winston** (Structured logging)
- **Helmet, CORS, Compression, Morgan** (Standard production middleware)
- **Express Rate Limit** (DDoS/enumeration defense)

---

## Architecture Summary & High Availability (HA)
The microservice strictly handles communication with payment providers (IP bound) and provides database-backed idempotency protection. The Next.js application remains the absolute source of truth for user profiles, wallet balances, PIN validation, and business rules.

To guarantee maximum system availability, the gateway implements **Fault-Tolerant High Availability Fallbacks**:
- If Firebase Admin credentials are not supplied or if Firestore experiences an outage, the microservice gracefully degrades and automatically switches to **`InMemoryIdempotency`** for processed references, ensuring payment flows never crash or block.

---

## Firestore Collection Design

### 1. `gateway_idempotency_references`
- **Purpose:** Prevents duplicate S2S payment/transfer execution (double-spending protection).
- **Schema:**
```typescript
{
  "reference": string,            // Document ID (Transaction Reference)
  "provider": "flutterwave" | "paystack",
  "provider_reference": string | null, // Provider transaction/transfer ID
  "timestamp": string,            // ISO DateTime
  "status": "success" | "pending" | "failed"
}
```

### 2. `gateway_processed_webhooks`
- **Purpose:** Webhook replay attack protection.
- **Schema:**
```typescript
{
  "transactionId": string,        // Document ID (Provider Transaction ID)
  "provider": "flutterwave" | "paystack",
  "eventType": string,            // e.g. "charge.completed"
  "timestamp": string             // ISO DateTime
}
```

---

## Environment Variables Configuration

Create a `.env` file in the root directory:

```env
# Server Configuration
PORT=3055
NODE_ENV=development

# Security & CORS
GATEWAY_API_KEYS=your_api_key_1,your_api_key_2 # Comma-separated for key rotation
JWT_SECRET=your_jwt_secret_here
CORS_ALLOWED_ORIGINS=https://yourwallet.vercel.app,http://localhost:3000

# Flutterwave Configuration
FLW_BASE_URL=https://api.flutterwave.com/v3
FLW_PUBLIC_KEY=FLWPUBK-xxxxxxxxxxxxxxxxxxxxxxxx-X
FLW_SECRET_KEY=FLWSECK-xxxxxxxxxxxxxxxxxxxxxxxx-X
FLW_WEBHOOK_SECRET=your_flw_webhook_secret_here

# Paystack Configuration
PAYSTACK_BASE_URL=https://api.paystack.co
PAYSTACK_PUBLIC_KEY=pk_test_xxxxxxxxxxxxxxxxxxxxxxxx
PAYSTACK_SECRET_KEY=sk_test_xxxxxxxxxxxxxxxxxxxxxxxx
PAYSTACK_WEBHOOK_SECRET=your_paystack_webhook_secret_here

# Firebase Admin configuration
FIREBASE_PROJECT_ID=e-tech-global-hub
FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxxx@e-tech-global-hub.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC...\n-----END PRIVATE KEY-----\n"
```

---

## Getting Started

### Installation
```bash
npm install
```

### Running Locally
```bash
npm run dev
```

### Building for Production
```bash
npm run build
npm start
```

### Running Tests
```bash
npm test
```

---

## API Documentation

### System & Health

#### Get Service Health
- **Endpoint:** `GET /health`
- **Response:**
```json
{
  "status": "ok"
}
```

---

### Flutterwave Provider Endpoints

#### Account Resolution
- **Endpoint:** `POST /api/flutterwave/resolve-account`
- **Request Body:**
```json
{
  "account_number": "0123456789",
  "bank_code": "044"
}
```
- **Success Response (HTTP 200):**
```json
{
  "success": true,
  "account_name": "JOHN DOE",
  "account_number": "0123456789",
  "bank_code": "044"
}
```

---

#### Initiate Outward Transfer
- **Endpoint:** `POST /api/flutterwave/transfer`
- **Request Body:**
```json
{
  "amount": 5000,
  "account_number": "0123456789",
  "bank_code": "044",
  "account_name": "SARAH SMITH CONNOR",
  "currency": "NGN",
  "narration": "E-Tech Salary Payout",
  "reference": "salary-999-2026-07"
}
```
- **Success Response (HTTP 200):**
```json
{
  "success": true,
  "reference": "salary-999-2026-07",
  "provider_reference": "778899",
  "status": "pending",
  "message": "Transfer initiated successfully."
}
```

---

#### Create Permanent Virtual Account
- **Endpoint:** `POST /api/flutterwave/create-virtual-account`
- **Request Body:**
```json
{
  "email": "test-user@e-tech-hub.com",
  "is_permanent": true,
  "bvn": "22222222222",
  "tx_ref": "va-user-123-999",
  "phonenumber": "08012345678",
  "firstname": "Sarah",
  "lastname": "Connor"
}
```
- **Success Response (HTTP 200):**
```json
{
  "success": true,
  "bank_name": "Wema Bank",
  "account_number": "9981452901",
  "account_name": "Sarah Connor - E-Tech",
  "currency": "NGN",
  "reference": "va-user-123-999"
}
```

---

#### Payment Verification
- **Endpoint:** `POST /api/flutterwave/verify`
- **Request Body:**
```json
{
  "transaction_id": "567890"
}
```
- **Success Response (HTTP 200):**
```json
{
  "success": true,
  "status": "successful",
  "amount": 2500,
  "currency": "NGN",
  "reference": "flw-tx-999-12345",
  "flw_id": "567890",
  "customer": {
    "name": "John Doe",
    "email": "john@doe.com",
    "phone": "09088887777"
  }
}
```

---

#### Transaction Webhook Handler
- **Endpoint:** `POST /api/flutterwave/webhook`
- **Headers:**
  - `verif-hash`: `<hash>`
- **Response (HTTP 200):**
```json
{
  "success": true,
  "message": "Webhook payload verified and captured."
}
```
