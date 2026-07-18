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
