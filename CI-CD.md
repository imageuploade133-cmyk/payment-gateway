# CI/CD Automated Deployment Guide

Our GitHub Actions pipeline automate testing, building, and deployment cycles to the Google Cloud VM on every `push` to the `main` branch.

---

## 1. Secrets Configuration

Configure the following credentials inside the GitHub Repository Secrets (`Settings -> Secrets and variables -> Actions`):

| Secret Name | Purpose | Example Value |
| :--- | :--- | :--- |
| `GCP_VM_HOST` | Static IP of your Google Cloud VM | `34.120.45.9` |
| `GCP_VM_USER` | Deployment user configured on the VM | `deploy_user` |
| `GCP_SSH_PRIVATE_KEY` | Private SSH Key matching VM's authorized keys | `-----BEGIN RSA PRIVATE KEY-----...` |

---

## 2. Pipeline Execution Order
1. **Lint & Test Stage:** Pulls code, runs Jest tests (`npm test`), and verifies full TypeScript compiling (`npm run build`).
2. **Secure SSH Pull:** Connects to VM static IP, runs `git pull`, installs dependencies with `npm ci`, and recompiles files.
3. **Graceful Cluster Reload:** Executes `pm2 reload ecosystem.config.js` to roll out the update with zero-downtime.
4. **Post-deploy Health Auditing:** Performs a cURL probe checking if `GET /health` returns status HTTP 200 within 3 seconds.
5. **Auto-Rollback:** If the health check fails, the pipeline automatically issues a rollback command to the previous stable PM2 instance and halts execution.
