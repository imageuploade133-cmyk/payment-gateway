import app from "./app";
import { env } from "./config/env";
import logger from "./config/logger";

import { ReconciliationService } from "./services/reconciliationService";

const server = app.listen(env.PORT, () => {
  logger.info(`==================================================`);
  logger.info(`🚀 Secure Payment Gateway Microservice is running`);
  logger.info(`🌐 Port: ${env.PORT}`);
  logger.info(`🛠️  Environment: ${env.NODE_ENV}`);
  logger.info(`🔐 FLW_WEBHOOK_SECRET Configured: ${!!env.FLW_WEBHOOK_SECRET}`);
  logger.info(`==================================================`);

  // Start background 60s automated transfer reconciliation loop (Task 5)
  try {
    ReconciliationService.getInstance().startAutomatedReconciliation();
  } catch (err: any) {
    logger.error(`Failed to start automated reconciliation background loop: ${err.message}`);
  }
});

// Graceful shutdown
const handleShutdown = (signal: string) => {
  logger.info(`Received ${signal}. Shutting down server gracefully...`);
  server.close(() => {
    logger.info("HTTP server closed.");
    process.exit(0);
  });
};

process.on("SIGTERM", () => handleShutdown("SIGTERM"));
process.on("SIGINT", () => handleShutdown("SIGINT"));
