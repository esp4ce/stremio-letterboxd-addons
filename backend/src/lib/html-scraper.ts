import { config } from '../config/index.js';

const BOXD_SHORTLINK_REGEX = /https?:\/\/boxd\.it\/([A-Za-z0-9]+)/;
const LIST_SHORTLINK_TAG_REGEX = /<link[^>]+rel="shortlink"[^>]+href="https?:\/\/boxd\.it\/([A-Za-z0-9]+)"/;
const LIST_SHORTLINK_TAG_ALT_REGEX = /href="https?:\/\/boxd\.it\/([A-Za-z0-9]+)"[^>]*rel="shortlink"/;
const LIST_LIKEABLE_IDENTIFIER_REGEX =
  /data-likeable-identifier='([^']+)'/;

const BROWSER_FETCH_OPTIONS: RequestInit = {
  headers: { 'User-Agent': config.CATALOG_USER_AGENT },
  redirect: 'follow',
};

export async function fetchPageHtml(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, { ...BROWSER_FETCH_OPTIONS, signal: controller.signal });
    if (!response.ok) return null;
    return response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function extractBoxdShortlinkId(html: string): string | null {
  return html.match(BOXD_SHORTLINK_REGEX)?.[1] ?? null;
}

export function extractListIdFromListPage(html: string): string | null {
  const shortlinkId =
    html.match(LIST_SHORTLINK_TAG_REGEX)?.[1] ??
    html.match(LIST_SHORTLINK_TAG_ALT_REGEX)?.[1];
  if (shortlinkId) return shortlinkId;

  // Extract data-likeable-identifier and decode HTML entities (&#034; / &quot; → ")
  const likeableMatch = html.match(LIST_LIKEABLE_IDENTIFIER_REGEX);
  if (likeableMatch) {
    const decoded = likeableMatch[1]!
      .replace(/&#034;/g, '"')
      .replace(/&quot;/g, '"');
    try {
      const parsed = JSON.parse(decoded) as { type?: string; lid?: string };
      if (parsed.type === 'list' && parsed.lid) return parsed.lid;
    } catch { /* ignore parse errors */ }
  }

  return null;
}
