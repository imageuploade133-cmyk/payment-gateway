# Nginx Proxy & SSL Hardening Guide

Nginx acts as our high-performance reverse proxy and SSL termination point. It provides DDoS defense, rate-limiting, Gzip compression, and HTTP/2 protocol support.

---

## 1. Nginx Installation

```bash
sudo apt update
sudo apt install nginx -y
```

---

## 2. Config Registration

Copy the `nginx.conf` file from the repository root to Nginx's configurations:

```bash
sudo cp nginx.conf /etc/nginx/sites-available/payment-gateway
sudo ln -s /etc/nginx/sites-available/payment-gateway /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default # Remove default mapping
```

Verify that the config has no syntax issues:
```bash
sudo nginx -t
```

---

## 3. SSL Setup (Let's Encrypt Certbot)

We use Let's Encrypt Certbot to request and automatically renew SSL certificates:

```bash
# Install Certbot via Snap
sudo apt install snapd
sudo snap install core; sudo snap refresh core
sudo snap install --classic certbot

# Request certificate
sudo certbot --nginx -d gateway.yourdomain.com
```

---

## 4. Automatic SSL Renewal

Certbot automatically configures a systemd timer for renewals. Verify that the renewal service runs cleanly:

```bash
sudo certbot renew --dry-run
```
