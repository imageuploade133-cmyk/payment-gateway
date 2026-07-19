import express from "express";
import helmet from "helmet";
import cors from "cors";
import compression from "compression";
import morgan from "morgan";
import { standardRateLimiter } from "./middleware/rateLimiter";
import { errorHandler } from "./middleware/errorHandler";
import { requestIdMiddleware } from "./middleware/requestId";
import routes from "./routes";
import logger from "./config/logger";
import { env } from "./config/env";

const app = express();

// Request ID middleware (must be first)
app.use(requestIdMiddleware);

// Security headers
app.use(helmet());

// Hardened CORS origin whitelisting
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || env.CORS_ALLOWED_ORIGINS.includes("*")) {
      return callback(null, true);
    }
    if (env.CORS_ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    logger.warn(`[CORS] Request origin blocked: ${origin}`);
    callback(new Error("CORS policy violation: origin not whitelisted."));
  },
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "X-Request-ID", "X-API-Key"],
}));

// Request limiting
app.use(standardRateLimiter);

// Compression
app.use(compression());

// Strict Request Size Limits + Raw Body Capture for exact byte-for-byte webhook cryptographic validations
app.use(
  express.json({
    limit: "10kb",
    verify: (req: any, res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(
  express.urlencoded({
    extended: true,
    limit: "10kb",
    verify: (req: any, res, buf) => {
      req.rawBody = buf;
    },
  })
);

// HTTP Request logging with Request ID
const morganStream = {
  write: (message: string) => logger.http(message.trim()),
};
app.use(
  morgan(
    ":method :url :status :res[content-length] - :response-time ms | reqId=:req[x-request-id]",
    { stream: morganStream }
  )
);

// Mount all routes
app.use(routes);

// Central error handler
app.use(errorHandler);

export default app;
