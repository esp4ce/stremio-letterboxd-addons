import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { loginBodySchema, preferencesBodySchema } from './auth.schemas.js';
import { loginUser, AuthenticationError } from './auth.service.js';
import { verifyUserToken } from '../../lib/jwt.js';
import {
  findUserById,
  updateUserPreferences,
} from '../../db/repositories/user.repository.js';
import { loginRateLimit } from '../../middleware/rate-limit.js';
import { trackEvent } from '../../lib/metrics.js';
import { usernameToAnonId } from '../../lib/anonymous-id.js';
import { callWithAppToken } from '../../lib/app-client.js';
import { fetchPageHtml, extractBoxdShortlinkId, extractListIdFromListPage } from '../../lib/html-scraper.js';
import {
  searchMemberByUsername as rawSearchMemberByUsername,
  getMember as rawGetMember,
  getUserLists as rawGetUserLists,
  searchLists as rawSearchLists,
  getList as rawGetList,
  LetterboxdApiError,
} from '../letterboxd/letterboxd.client.js';

async function resolveMemberByUsername(username: string) {
  const profileUrl = `https://letterboxd.com/${username}/`;
  const profileHtml = await fetchPageHtml(profileUrl);

  if (profileHtml) {
    const memberLid = extractBoxdShortlinkId(profileHtml);
    if (memberLid) {
      try {
        return await callWithAppToken((token) => rawGetMember(token, memberLid));
      } catch {
        // fallback to username search
      }
    }
  }

  return callWithAppToken((token) => rawSearchMemberByUsername(token, username));
}

/** Extract normalized words from text (strips diacritics + apostrophes) */
function extractWords(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[''ʼ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
}

function wordsOverlap(nameWords: string[], slugWords: string[]): boolean {
  const nameSet = new Set(nameWords);
  const slugSet = new Set(slugWords);

  const slugInName = slugWords.filter((w) => nameSet.has(w)).length;
  const nameInSlug = nameWords.filter((w) => slugSet.has(w)).length;

  return slugInName >= slugWords.length * 0.8
      && nameInSlug >= nameWords.length * 0.6;
}

/** Match a list name against a URL slug using bidirectional word overlap */
function matchesSlug(listName: string, urlSlug: string): boolean {
  const nameWords = extractWords(listName);
  const slugWords = urlSlug.split('-').filter((w) => w.length > 0);

  // Try full slug first (handles "top-10", "apollo-13", etc.)
  if (wordsOverlap(nameWords, slugWords)) return true;

  // Retry without trailing number — Letterboxd dedup suffix ("monster-high-1")
  const stripped = urlSlug.replace(/-\d+$/, '');
  if (stripped !== urlSlug) {
    return wordsOverlap(nameWords, stripped.split('-').filter((w) => w.length > 0));
  }

  return false;
}

export async function authRoutes(app: FastifyInstance) {
  app.post(
    '/auth/login',
    {
      config: { rateLimit: loginRateLimit },
      schema: {
        body: {
          type: 'object',
          properties: {
            username: { type: 'string' },
            password: { type: 'string' },
          },
          required: ['username', 'password'],
        },
      },
    },
    async (
      request: FastifyRequest<{
        Body: { username: string; password: string };
      }>,
      reply
    ) => {
      const body = loginBodySchema.safeParse(request.body);

      if (!body.success) {
        return reply.status(400).send({
          error: 'Validation failed',
          details: body.error.issues,
        });
      }

      try {
        const result = await loginUser(body.data.username, body.data.password);
        trackEvent('login', result.user?.id);
        return result;
      } catch (error) {
        if (error instanceof AuthenticationError) {
          const statusCode =
            error.code === 'INVALID_CREDENTIALS' ? 401 : 503;
          return reply.status(statusCode).send({
            error: error.message,
            code: error.code,
          });
        }
        throw error;
      }
    }
  );

  app.post(
    '/auth/preferences',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            userToken: { type: 'string' },
            preferences: { type: 'object' },
          },
          required: ['userToken', 'preferences'],
        },
      },
    },
    async (
      request: FastifyRequest<{
        Body: { userToken: string; preferences: unknown };
      }>,
      reply
    ) => {
      const parsed = preferencesBodySchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Validation failed',
          details: parsed.error.issues,
        });
      }

      const payload = await verifyUserToken(parsed.data.userToken);
      if (!payload) {
        return reply.status(401).send({ error: 'Invalid or expired token' });
      }

      const user = findUserById(payload.sub);
      if (!user) {
        return reply.status(404).send({ error: 'User not found' });
      }

      updateUserPreferences(user.id, parsed.data.preferences);

      return { success: true };
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Public endpoints (using app token, no user auth required)
  // ═══════════════════════════════════════════════════════════════════════════

  const validateUsernameSchema = z.object({
    username: z.string().min(1).max(100),
  });

  app.post(
    '/auth/validate-username',
    {
      schema: {
        body: {
          type: 'object',
          properties: { username: { type: 'string' } },
          required: ['username'],
        },
      },
    },
    async (
      request: FastifyRequest<{ Body: { username: string } }>,
      reply
    ) => {
      const parsed = validateUsernameSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid username' });
      }

      try {
        const member = await resolveMemberByUsername(parsed.data.username);

        if (!member) {
          return { valid: false };
        }

        trackEvent('validate_username', undefined, { found: true }, usernameToAnonId(parsed.data.username));

        // Fetch user's public lists
        const listsResponse = await callWithAppToken((token) =>
          rawGetUserLists(token, member.id, { perPage: 50 })
        );

        const lists = listsResponse.items.map((l) => ({
          id: l.id,
          name: l.name,
          filmCount: l.filmCount,
        }));

        return {
          valid: true,
          memberId: member.id,
          displayName: member.displayName || member.username,
          username: member.username,
          lists,
        };
      } catch {
        return reply.status(500).send({ error: 'Failed to validate username' });
      }
    }
  );

  const resolveListSchema = z.object({
    url: z.string().min(1).max(500),
  });

  // Top 250 list is available as a built-in catalog
  const TOP_250_LIST_ID = '8HjM';

  app.post(
    '/auth/resolve-list-public',
    {
      schema: {
        body: {
          type: 'object',
          properties: { url: { type: 'string' } },
          required: ['url'],
        },
      },
    },
    async (
      request: FastifyRequest<{ Body: { url: string } }>,
      reply
    ) => {
      const parsed = resolveListSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid URL' });
      }

      // Validate it looks like a Letterboxd list URL
      const urlMatch = parsed.data.url.match(
        /(?:https?:\/\/)?(?:www\.)?letterboxd\.com\/([^/]+)\/list\/([^/]+)/
      );

      if (!urlMatch) {
        return reply.status(400).send({ error: 'Invalid Letterboxd list URL' });
      }

      try {
        // Strategy 1: Fetch public HTML page and extract boxd.it shortlink
        const normalizedUrl = parsed.data.url.startsWith('http')
          ? parsed.data.url
          : `https://${parsed.data.url}`;

        const pageHtml = await fetchPageHtml(normalizedUrl);

        if (pageHtml) {
          const listId = extractListIdFromListPage(pageHtml);

          if (listId) {
            request.log.info({ listId, url: normalizedUrl }, 'Strategy 1: extracted list ID from HTML');
            try {
              const list = await callWithAppToken((token) =>
                rawGetList(token, listId)
              );

              // Block Top 250 list - already available as built-in catalog
              if (list.id === TOP_250_LIST_ID) {
                return reply.status(400).send({
                  error: 'This list is already available as a built-in catalog (Top 250 Narrative Features)',
                });
              }

              const ownerName = list.owner?.displayName || list.owner?.username || 'Unknown';

              return {
                id: list.id,
                name: list.name,
                owner: ownerName,
                filmCount: list.filmCount,
              };
            } catch (err) {
              // Lookup failed (404, private list, etc.) - fallback to strategy 2
              if (err instanceof LetterboxdApiError && err.status === 404) {
                request.log.warn({ listId }, 'Strategy 1: API returned 404 for extracted ID, falling back');
              } else {
                throw err; // Re-throw non-404 errors
              }
            }
          } else {
            request.log.warn({ url: normalizedUrl }, 'Strategy 1: no list ID found in HTML');
          }
        } else {
          request.log.warn({ url: normalizedUrl }, 'Strategy 1: failed to fetch HTML page');
        }

        // Strategy 2 (fallback): Resolve member → get all lists → match by words
        const [, username, rawListSlug] = urlMatch;
        const listSlug = rawListSlug!.split(/[?#]/)[0]!.replace(/\/$/, '').toLowerCase();

        request.log.info({ username, listSlug }, 'Strategy 2: resolving member and fetching lists');

        const member = await resolveMemberByUsername(username!);
        if (!member) {
          return reply.status(404).send({ error: 'List not found' });
        }

        // Paginate through member's lists and match by word overlap
        let cursor: string | undefined;
        let page = 0;

        while (page < 5) {
          page++;
          const listsResponse = await callWithAppToken((token) =>
            rawSearchLists(token, { member: member.id, memberRelationship: 'Owner', perPage: 100, cursor })
          );

          const matched = listsResponse.items.find((l) => matchesSlug(l.name, listSlug));

          if (matched) {
            if (matched.id === TOP_250_LIST_ID) {
              return reply.status(400).send({
                error: 'This list is already available as a built-in catalog (Top 250 Narrative Features)',
              });
            }
            return {
              id: matched.id,
              name: matched.name,
              owner: matched.owner?.displayName || matched.owner?.username || member.displayName || member.username,
              filmCount: matched.filmCount,
            };
          }

          cursor = listsResponse.cursor;
          if (!cursor) break;
        }

        request.log.warn({ username, listSlug, memberId: member.id }, 'Strategy 2: no match found');
        return reply.status(404).send({ error: 'List not found' });
      } catch (err) {
        request.log.error({ err, url: parsed.data.url }, 'resolve-list-public failed');
        return reply.status(500).send({ error: 'Failed to resolve list' });
      }
    }
  );
}
