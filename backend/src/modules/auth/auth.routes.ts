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
import { callWithAppToken } from '../../lib/app-client.js';
import { config } from '../../config/index.js';
import {
  searchMemberByUsername as rawSearchMemberByUsername,
  getMember as rawGetMember,
  getUserLists as rawGetUserLists,
  searchLists as rawSearchLists,
  getList as rawGetList,
  LetterboxdApiError,
} from '../letterboxd/letterboxd.client.js';

const BOXD_SHORTLINK_REGEX = /https?:\/\/boxd\.it\/([A-Za-z0-9]+)/;
const LIST_SHORTLINK_TAG_REGEX = /<link[^>]+rel="shortlink"[^>]+href="https?:\/\/boxd\.it\/([A-Za-z0-9]+)"/;
const LIST_SHORTLINK_TAG_ALT_REGEX = /href="https?:\/\/boxd\.it\/([A-Za-z0-9]+)"[^>]*rel="shortlink"/;
const LIST_LIKEABLE_IDENTIFIER_REGEX =
  /data-likeable-identifier=(?:"|')\{"lid":"([A-Za-z0-9]+)","uid":"filmlist:[^"']+","type":"list","typeName":"list"\}(?:"|')/;

const BROWSER_FETCH_OPTIONS: RequestInit = {
  headers: { 'User-Agent': config.LETTERBOXD_USER_AGENT },
  redirect: 'follow',
};

async function fetchPageHtml(url: string): Promise<string | null> {
  const response = await fetch(url, BROWSER_FETCH_OPTIONS);
  if (!response.ok) return null;
  return response.text();
}

function extractBoxdShortlinkId(html: string): string | null {
  return html.match(BOXD_SHORTLINK_REGEX)?.[1] ?? null;
}

function extractListIdFromListPage(html: string): string | null {
  const shortlinkId =
    html.match(LIST_SHORTLINK_TAG_REGEX)?.[1] ??
    html.match(LIST_SHORTLINK_TAG_ALT_REGEX)?.[1];
  const likeableId = html.match(LIST_LIKEABLE_IDENTIFIER_REGEX)?.[1];
  return shortlinkId ?? likeableId ?? null;
}

async function resolveMemberByUsername(username: string) {
  const profileUrl = `https://letterboxd.com/${username}/`;
  const profileHtml = await fetchPageHtml(profileUrl);

  if (profileHtml) {
    const memberLid = extractBoxdShortlinkId(profileHtml);
    if (memberLid) {
      try {
        return await callWithAppToken((token) => rawGetMember(token, memberLid));
      } catch {
        // fallback to API search
      }
    }
  }

  return callWithAppToken((token) => rawSearchMemberByUsername(token, username));
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
              // API failed (404, private list, etc.) - fallback to strategy 2
              if (err instanceof LetterboxdApiError && err.status === 404) {
                // Continue to fallback strategy
              } else {
                throw err; // Re-throw non-404 errors
              }
            }
          }
        }

        // Strategy 2 (fallback): Resolve member reliably, then match list slug
        const [, username, listSlug] = urlMatch;

        const member = await resolveMemberByUsername(username!);

        if (!member) {
          return reply.status(404).send({ error: 'List not found' });
        }

        const normalizeSlug = (name: string) =>
          name.toLowerCase()
            .replace(/['’]/g, '')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '');

        // Paginate through member's lists to find the matching slug
        let cursor: string | undefined;
        let page = 0;

        while (page < 5) {
          page++;
          const listsResponse = await callWithAppToken((token) =>
            rawSearchLists(token, { member: member.id, memberRelationship: 'Owner', perPage: 100, cursor })
          );

          const matchedList = listsResponse.items.find(
            (l) => normalizeSlug(l.name) === listSlug!.toLowerCase()
          );

          if (matchedList) {
            if (matchedList.id === TOP_250_LIST_ID) {
              return reply.status(400).send({
                error: 'This list is already available as a built-in catalog (Top 250 Narrative Features)',
              });
            }

            return {
              id: matchedList.id,
              name: matchedList.name,
              owner: member.displayName || member.username,
              filmCount: matchedList.filmCount,
            };
          }

          cursor = listsResponse.cursor;
          if (!cursor) break;
        }

        return reply.status(404).send({ error: 'List not found' });
      } catch {
        return reply.status(500).send({ error: 'Failed to resolve list' });
      }
    }
  );
}
