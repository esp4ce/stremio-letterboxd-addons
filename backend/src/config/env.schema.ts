import { z } from 'zod';

export const envSchema = z.object({
  PORT: z.coerce.number().default(3001),
  PUBLIC_URL: z.string().url().default('http://localhost:3001'),

  ENABLE_HTTPS: z
    .string()
    .transform((val) => val === 'true')
    .default('false'),
  HTTPS_CERT_PATH: z.string().default('./certs/localhost-cert.pem'),
  HTTPS_KEY_PATH: z.string().default('./certs/localhost-key.pem'),

  LETTERBOXD_CLIENT_ID: z.string().min(1),
  LETTERBOXD_CLIENT_SECRET: z.string().min(1),
  LETTERBOXD_USER_AGENT: z.string().default('StremioLetterboxdAddon/1.0.0'),

  ENCRYPTION_KEY: z
    .string()
    .length(64, 'ENCRYPTION_KEY must be 64 hex characters (32 bytes)')
    .regex(/^[0-9a-fA-F]+$/, 'ENCRYPTION_KEY must be hexadecimal'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_TTL: z.string().default('7d'),
  DASHBOARD_PASSWORD: z.string().min(8, 'DASHBOARD_PASSWORD must be at least 8 characters'),

  DATABASE_PATH: z.string().default('./data/stremio-letterboxd.db'),

  CACHE_MAX_SIZE: z.coerce.number().default(1000),
  CACHE_FILM_TTL: z.coerce.number().default(3600),
  CACHE_WATCHLIST_TTL: z.coerce.number().default(300),

  CORS_ORIGIN: z.string().default('http://localhost:3000'),
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
    .default('info'),
});

export type Env = z.infer<typeof envSchema>;
