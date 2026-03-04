import { envSchema, type Env } from './env.schema.js';

function loadConfig(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error('❌ Invalid environment variables:');
    for (const issue of result.error.issues) {
      console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }

  return result.data;
}

export const config = loadConfig();

export const catalogConfig = {
  clientId: config.CATALOG_CLIENT_ID,
  clientSecret: config.CATALOG_CLIENT_SECRET,
  userAgent: config.CATALOG_USER_AGENT,
} as const;

export const jwtConfig = {
  secret: config.JWT_SECRET,
  ttl: config.JWT_TTL,
} as const;

export const cacheConfig = {
  maxSize: config.CACHE_MAX_SIZE,
  filmTtl: config.CACHE_FILM_TTL * 1000,
  watchlistTtl: config.CACHE_WATCHLIST_TTL * 1000,
} as const;

export const tmdbConfig = {
  apiKey: config.TMDB_API_KEY,
} as const;

export const serverConfig = {
  publicUrl: config.PUBLIC_URL,
} as const;
