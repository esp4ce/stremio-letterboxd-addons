import { authenticateAsApp, LetterboxdApiError } from '../modules/letterboxd/letterboxd.client.js';
import { createChildLogger } from './logger.js';

const logger = createChildLogger('app-client');

let appToken: string | null = null;
let tokenExpiry = 0;

export async function getAppToken(): Promise<string> {
  if (appToken && Date.now() < tokenExpiry) return appToken;

  logger.info('Requesting new app token');
  const response = await authenticateAsApp();
  appToken = response.access_token;
  // Refresh 60s before actual expiry
  tokenExpiry = Date.now() + (response.expires_in - 60) * 1000;
  logger.info({ expiresIn: response.expires_in }, 'App token acquired');
  return appToken;
}

export async function callWithAppToken<T>(
  fn: (token: string) => Promise<T>
): Promise<T> {
  const token = await getAppToken();
  try {
    return await fn(token);
  } catch (err) {
    if (err instanceof LetterboxdApiError && err.status === 401) {
      logger.info('App token expired (401), refreshing');
      appToken = null;
      const newToken = await getAppToken();
      return fn(newToken);
    }
    throw err;
  }
}
