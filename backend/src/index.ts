import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { configure } from '@esp4ce/letterboxd-client';
import { buildApp } from './app.js';
import { initDb, closeDb } from './db/index.js';
import { config, letterboxdConfig } from './config/index.js';
import { logger, createChildLogger } from './lib/logger.js';
import { cleanupOldEvents } from './lib/metrics.js';

async function main() {
  logger.info('Starting Stremio Letterboxd Backend...');

  initDb();

  // Cleanup old events (keep last 90 days)
  const deletedCount = cleanupOldEvents(90);
  if (deletedCount > 0) {
    logger.info({ deletedCount }, 'Cleaned up old events');
  }

  configure({
    clientId: letterboxdConfig.clientId,
    clientSecret: letterboxdConfig.clientSecret,
    userAgent: letterboxdConfig.userAgent,
    logger: createChildLogger('letterboxd'),
  });

  let app;

  if (config.ENABLE_HTTPS) {
    try {
      const httpsOptions = {
        key: readFileSync(config.HTTPS_KEY_PATH),
        cert: readFileSync(config.HTTPS_CERT_PATH),
      };
      app = await buildApp(httpsOptions);
      logger.info('HTTPS enabled with certificates');
    } catch (error) {
      logger.fatal(
        { err: error instanceof Error ? { message: error.message, stack: error.stack } : error },
        'Failed to load SSL certificates. Run "cd certs && generate.bat" to generate them.'
      );
      process.exit(1);
    }
  } else {
    app = await buildApp();
    logger.info('HTTP mode (no HTTPS)');
  }

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Received shutdown signal');
    await app.close();
    closeDb();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await app.listen({ port: config.PORT, host: '0.0.0.0' });
    logger.info(
      { port: config.PORT, url: config.PUBLIC_URL, https: config.ENABLE_HTTPS },
      'Server started'
    );
  } catch (error) {
    logger.fatal({ error }, 'Failed to start server');
    process.exit(1);
  }
}

main();
