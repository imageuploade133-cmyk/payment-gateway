import express from "express";
import helmet from "helmet";
import cors from "cors";
import compression from "compression";
import morgan from "morgan";
import { standardRateLimiter } from "./middleware/rateLimiter";
import { errorHandler } from "./middleware/errorHandler";
import routes from "./routes";
import logger from "./config/logger";

const app = express();

// Security middleware
app.use(helmet());
app.use(cors({
  origin: "*", // Adjust as necessary for Next.js security
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
}));

// Request limiting
app.use(standardRateLimiter);

// Compression & parsing
app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// HTTP Request logging
const morganStream = {
  write: (message: string) => logger.http(message.trim()),
};
app.use(morgan(":method :url :status :res[content-length] - :response-time ms", { stream: morganStream }));

// Mount all routes
app.use(routes);

// Central error handler
app.use(errorHandler);

export default app;
