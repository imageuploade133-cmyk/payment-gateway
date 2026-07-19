# GCP VM Production Deployment Guide

This document describes the step-by-step instructions to set up, secure, and run the Payment Gateway microservice on a Google Cloud VM with a Static IP.

---

## 1. Initial VM Server Provisioning

```bash
# Update local packages
sudo apt update && sudo apt upgrade -y

# Install Node.js 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Confirm versions
node -v
npm -v

# Install PM2 Process Manager globally
sudo npm install -p -g pm2
```

---

## 2. Firewall Port Access Controls
Ensure that only Vercel S2S IP lists (or public webhooks for payment providers) are permitted to route requests:
- Port `80`: Allow HTTP (will be redirected to HTTPS).
- Port `443`: Allow HTTPS (production access).
- Port `3055` (Internal Node port): Strictly block from public routing (only accessed internally via Nginx proxy).

---

## 3. Deployment Steps

```bash
# Clone repository code
git clone https://github.com/imageuploade133-cmyk/payment-gateway.git
cd payment-gateway

# Configure production parameters
cp .env.example .env
nano .env # Input secure production secrets

# Install packages & compile files
npm ci
npm run build

# Start process cluster under PM2
pm2 start ecosystem.config.js --env production
```

---

## 4. Backups and Auditing
To preserve audit logs and transaction history:
- Logs are rotated automatically under PM2 and Winston.
- Access files and errors logs are separated inside `logs/` directory.

---

## 5. Rollback Procedure
If a production deployment is corrupted or fails health checks:

```bash
# Roll back code to the last stable git tag/commit
git reset --hard HEAD@{1}

# Recompile and build
npm ci
npm run build

# Refresh PM2 cluster
pm2 reload ecosystem.config.js --env production
```
