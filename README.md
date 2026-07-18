# Payment Gateway Microservice

A production-ready, enterprise-grade payment gateway microservice designed to act as a secure bridge between the E-Tech Wallet Next.js application (on Vercel) and payment providers (Flutterwave, Paystack, etc.).

This microservice runs on a Google Cloud VM with a Static IP to fulfill IP whitelisting requirements of payment providers.

---

## Technical Stack
- **Node.js 22 LTS**
- **TypeScript**
- **Express.js**
- **Winston** (Structured logging)
- **Helmet, CORS, Compression, Morgan** (Standard production middleware)
- **Express Rate Limit** (DDoS/enumeration defense)

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
- **Description:** Returns the current operational status of the gateway.
- **Response:**
```json
{
  "status": "ok"
}
```

---

### Flutterwave Provider

#### Account Resolution
- **Endpoint:** `POST /api/flutterwave/resolve-account`
- **Description:** Securely resolves and verifies bank account details using the whitelisted Flutterwave provider bridge.
- **Rate Limit:** 30 attempts per 15 minutes per IP.
- **Headers:**
  - `Content-Type: application/json`
  - `X-Request-ID: <optional-unique-uuid>` (Auto-generated if omitted)
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
- **Error Response (HTTP 400):**
```json
{
  "success": false,
  "message": "Unable to verify account details. Please check the bank and account number."
}
```

---

#### Initiate Outward Transfer
- **Endpoint:** `POST /api/flutterwave/transfer`
- **Description:** Securely executes an outward single bank transfer using Flutterwave with built-in in-memory idempotency defense, automatic transient error retries, and request ID log binding.
- **Rate Limit:** 10 requests per 15 minutes per IP.
- **Headers:**
  - `Content-Type: application/json`
  - `X-Request-ID: <optional-unique-uuid>` (Auto-generated if omitted)
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
- **Error Response (HTTP 400 - Validation/Provider Error):**
```json
{
  "success": false,
  "reference": "salary-999-2026-07",
  "message": "Transfer could not be processed. Please check account details or try again later."
}
```
- **Error Response (HTTP 400 - Duplicate Reference):**
```json
{
  "success": false,
  "reference": "salary-999-2026-07",
  "message": "Duplicate transfer reference. This transaction has already been initiated."
}
```

---

#### Create Permanent Virtual Account
- **Endpoint:** `POST /api/flutterwave/create-virtual-account`
- **Description:** Provisions a permanent virtual account for a user securely over the whitelisted static IP node.
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
- **Description:** Explicitly queries and verifies a transaction ID directly against Flutterwave's ledger.
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
- **Description:** Secure webhook endpoint that processes signed Flutterwave transaction events (`charge.completed`) with built-in replay attack protection.
- **Headers:**
  - `verif-hash`: `<hash>`
- **Response (HTTP 200):**
```json
{
  "success": true,
  "message": "Webhook payload verified and captured."
}
```
