import app from "./app";
import { env } from "./config/env";
import logger from "./config/logger";

const server = app.listen(env.PORT, () => {
  logger.info(`==================================================`);
  logger.info(`🚀 Secure Payment Gateway Microservice is running`);
  logger.info(`🌐 Port: ${env.PORT}`);
  logger.info(`🛠️  Environment: ${env.NODE_ENV}`);
  logger.info(`==================================================`);
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
