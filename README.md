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

## Project Structure
```
payment-gateway/
├── src/
│   ├── config/            # Environment validation, logging setup
│   ├── controllers/       # Route request handlers
│   ├── middleware/        # Authentication, Error handling, Rate limiting
│   ├── routes/            # Express endpoint maps
│   ├── services/          # Business workflows
│   ├── providers/         # Low-level payment provider APIs
│   │   ├── flutterwave/
│   │   ├── paystack/
│   │   └── firebase/
│   ├── utils/             # Helper libraries
│   ├── types/             # Common TypeScript definitions
│   ├── app.ts             # Express App definition
│   └── server.ts          # Server entrypoint
├── .github/workflows/     # CI/CD deployment
├── ecosystem.config.js    # PM2 process config
├── .env.example           # Reference environment parameters
├── README.md              # Documentation
├── package.json           # Dependencies
└── tsconfig.json          # TS compilation profile
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
