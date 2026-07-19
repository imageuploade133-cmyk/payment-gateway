# PM2 Process Clustering & Graceful Lifecycles

PM2 is used to run our Express microservice as a high-availability server cluster, automatically restarting on crashes or memory leak limits, and coordinating zero-downtime hot reloads.

---

## 1. PM2 Commands Reference

```bash
# Start cluster defined in config
pm2 start ecosystem.config.js --env production

# Restart cluster with zero-downtime rolling reloads
pm2 reload ecosystem.config.js --env production

# View active logs in real-time
pm2 logs payment-gateway

# Stop cluster
pm2 stop payment-gateway

# Remove process mappings
pm2 delete payment-gateway
```

---

## 2. Server Startup Survivability

Configure PM2 to automatically start processes upon VM system reboot cycles:

```bash
pm2 startup
# Copy and execute the terminal output command provided by PM2

# Save current active list as the startup standard
pm2 save
```

---

## 3. Log Rotations (Preventing Disk Bloat)

To keep server disks from filling up with log files over months of continuous production execution:

```bash
pm2 install pm2-logrotate

# Configure rotation parameters
pm2 set pm2-logrotate:max_size 10M
pm2 set pm2-logrotate:retain 30
```
