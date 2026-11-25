import cors from 'cors';
import helmet from 'helmet';
import rateLimit, { Options as RateLimitOptions } from 'express-rate-limit';
import { errorResponse } from '../utils/response';

const DEFAULT_LOCAL_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

const DEV_LAN_ORIGIN_REGEX = /^https?:\/\/192\.168\.\d{1,3}\.\d{1,3}(:\d+)?$/;
const DEV_LOCALHOST_ORIGIN_REGEX = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

const normalizeOrigin = (origin: string): string => origin.trim().replace(/\/+$/, '');

export const getAllowedOrigins = (corsOriginEnv?: string): Set<string> => {
  const raw = corsOriginEnv ?? process.env.CORS_ORIGIN ?? '';
  const configured = raw
    .split(',')
    .map(normalizeOrigin)
    .filter((entry) => entry.length > 0);

  return new Set([...DEFAULT_LOCAL_ORIGINS, ...configured]);
};

export interface CorsCheckOptions {
  corsOriginEnv?: string;
  nodeEnv?: string;
}

export const isOriginAllowed = (
  origin: string | undefined,
  options?: CorsCheckOptions
): boolean => {
  // Allow native mobile clients (Flutter), curl, and K8s/Docker health probes without Origin header
  if (!origin) {
    return true;
  }

  const normalized = normalizeOrigin(origin);
  if (getAllowedOrigins(options?.corsOriginEnv).has(normalized)) {
    return true;
  }

  const env = options?.nodeEnv ?? process.env.NODE_ENV;
  if (
    env !== 'production' &&
    (DEV_LAN_ORIGIN_REGEX.test(normalized) || DEV_LOCALHOST_ORIGIN_REGEX.test(normalized))
  ) {
    return true;
  }

  return false;
};

export const helmetMiddleware = helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
});

export const createCorsMiddleware = (options?: CorsCheckOptions) =>
  cors({
    origin: (origin, callback) => {
      if (isOriginAllowed(origin, options)) {
        return callback(null, true);
      }
      return callback(errorResponse('Origin tidak diizinkan oleh kebijakan CORS', 403));
    },
    credentials: true,
  });

export const corsMiddleware = createCorsMiddleware();

export const createAuthRateLimiter = (overrides?: Partial<RateLimitOptions>) =>
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({
        success: false,
        message: 'Terlalu banyak percobaan autentikasi. Silakan coba lagi beberapa saat.',
      });
    },
    ...overrides,
  });

export const createAiRateLimiter = (overrides?: Partial<RateLimitOptions>) =>
  rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({
        success: false,
        message: 'Terlalu banyak permintaan AI. Silakan coba lagi beberapa saat.',
      });
    },
    ...overrides,
  });

export const authRateLimiter = createAuthRateLimiter();
export const aiRateLimiter = createAiRateLimiter();
