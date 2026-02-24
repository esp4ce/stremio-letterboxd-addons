import { config } from '../../config/index.js';
import type { UserList } from '../letterboxd/letterboxd.client.js';
import type { UserPreferences } from '../../db/repositories/user.repository.js';
import type { PublicConfig } from '../../lib/config-encoding.js';

// Stremio Addons verification
const STREMIO_ADDONS_CONFIG = {
  issuer: 'https://stremio-addons.net',
  signature: 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..I3PvePmUVrvubt0Oc0VHyw.JDBRxiddKlxnfCOo7WofztIGnkmzfUnbQeKoJEvwfGGArc1sg_m0fW24oy2XXIq_Ew8RWpPbQAoDUKculia_JFgBLck-p3VQ3gVXmsTPDdGsw1J_y26kYEIaFkQIp7Hd.4iM2G42fBrSjtYFS2bz5vQ',
};

export interface StremioResourceDescriptor {
  name: string;
  types: string[];
  idPrefixes?: string[];
}

export interface StremioManifest {
  id: string;
  version: string;
  name: string;
  description: string;
  logo: string;
  background: string;
  resources: (string | StremioResourceDescriptor)[];
  types: string[];
  idPrefixes?: string[];
  catalogs: StremioCatalog[];
  behaviorHints: {
    configurable: boolean;
    configurationRequired: boolean;
  };
  stremioAddonsConfig?: {
    issuer: string;
    signature: string;
  };
}

export interface StremioCatalog {
  type: string;
  id: string;
  name: string;
  extra?: Array<{
    name: string;
    isRequired?: boolean;
    options?: string[];
  }>;
}

// Keep the old interface name for backwards compatibility
export type StemioCatalog = StremioCatalog;

export const SORT_EXTRA_OPTIONS = [
  "Recently Added", "Oldest Added", "Film Name",
  "Release Date (Newest)", "Release Date (Oldest)",
  "Your Rating (High)", "Your Rating (Low)",
  "Average Rating (High)", "Average Rating (Low)",
  "Popularity", "Popularity (Week)", "Popularity (Month)",
  "Shortest", "Longest",
];

export const SORT_LABEL_TO_API: Record<string, string> = {
  "Recently Added": "DateLatestFirst",
  "Oldest Added": "DateEarliestFirst",
  "Film Name": "FilmName",
  "Release Date (Newest)": "ReleaseDateLatestFirst",
  "Release Date (Oldest)": "ReleaseDateEarliestFirst",
  "Your Rating (High)": "AuthenticatedMemberRatingHighToLow",
  "Your Rating (Low)": "AuthenticatedMemberRatingLowToHigh",
  "Average Rating (High)": "AverageRatingHighToLow",
  "Average Rating (Low)": "AverageRatingLowToHigh",
  "Popularity": "FilmPopularity",
  "Popularity (Week)": "FilmPopularityThisWeek",
  "Popularity (Month)": "FilmPopularityThisMonth",
  "Shortest": "FilmDurationShortestFirst",
  "Longest": "FilmDurationLongestFirst",
};

const SORT_EXTRA = { name: 'sort', options: SORT_EXTRA_OPTIONS, isRequired: false };

/**
 * Generate base catalogs for a user
 */
function getBaseCatalogs(displayName: string): StremioCatalog[] {
  return [
    {
      type: 'movie',
      id: 'letterboxd-watchlist',
      name: `${displayName}'s Watchlist`,
      extra: [SORT_EXTRA, { name: 'skip', isRequired: false }],
    },
    {
      type: 'movie',
      id: 'letterboxd-diary',
      name: `${displayName}'s Recent Diary`,
      extra: [SORT_EXTRA, { name: 'skip', isRequired: false }],
    },
    {
      type: 'movie',
      id: 'letterboxd-friends',
      name: `${displayName}'s Friends Activity`,
      extra: [{ name: 'skip', isRequired: false }],
    },
    {
      type: 'movie',
      id: 'letterboxd-liked-films',
      name: `${displayName}'s Liked Films`,
      extra: [SORT_EXTRA, { name: 'skip', isRequired: false }],
    },
    {
      type: 'movie',
      id: 'letterboxd-popular',
      name: 'Popular This Week',
      extra: [{ name: 'skip', isRequired: false }],
    },
    {
      type: 'movie',
      id: 'letterboxd-top250',
      name: 'Top 250 Narrative Features',
      extra: [{ name: 'skip', isRequired: false }],
    },
  ];
}

const catalogIdMap: Record<string, keyof UserPreferences['catalogs']> = {
  'letterboxd-watchlist': 'watchlist',
  'letterboxd-diary': 'diary',
  'letterboxd-friends': 'friends',
  'letterboxd-liked-films': 'likedFilms',
  'letterboxd-popular': 'popular',
  'letterboxd-top250': 'top250',
};

/**
 * Convert user lists to Stremio catalogs
 */
function listsToStremioCatalogs(lists: UserList[]): StremioCatalog[] {
  return lists.map((list) => ({
    type: 'movie',
    id: `letterboxd-list-${list.id}`,
    name: list.name,
    extra: [SORT_EXTRA, { name: 'skip', isRequired: false }],
  }));
}

/**
 * Generate base manifest for stremio-addons.net submission (Tier 1)
 * Only includes generic catalogs: Popular + Top 250
 */
export function generateBaseManifest(): StremioManifest {
  return {
    id: 'community.stremboxd',
    version: '1.0.0',
    name: 'Stremboxd',
    description: 'Letterboxd catalogs for Stremio: popular films, top 250, watchlists, and custom lists. Configure at https://stremboxd.com',
    logo: `${config.PUBLIC_URL}/logo.svg`,
    background: `${config.PUBLIC_URL}/logo.svg`,
    resources: ['catalog'],
    types: ['movie'],
    catalogs: [
      {
        type: 'movie',
        id: 'letterboxd-popular',
        name: 'Popular This Week',
        extra: [{ name: 'skip', isRequired: false }],
      },
      {
        type: 'movie',
        id: 'letterboxd-top250',
        name: 'Top 250 Narrative Features',
        extra: [{ name: 'skip', isRequired: false }],
      },
    ],
    behaviorHints: {
      configurable: true,
      configurationRequired: false,
    },
    stremioAddonsConfig: STREMIO_ADDONS_CONFIG,
  };
}

/**
 * Generate public manifest for Tier 2 (config-based, no auth)
 */
export function generatePublicManifest(
  cfg: PublicConfig,
  displayName?: string,
  listNames?: Map<string, string>
): StremioManifest {
  const catalogs: StremioCatalog[] = [];

  if (cfg.c.popular) {
    catalogs.push({
      type: 'movie',
      id: 'letterboxd-popular',
      name: 'Popular This Week',
      extra: [{ name: 'skip', isRequired: false }],
    });
  }

  if (cfg.c.top250) {
    catalogs.push({
      type: 'movie',
      id: 'letterboxd-top250',
      name: 'Top 250 Narrative Features',
      extra: [{ name: 'skip', isRequired: false }],
    });
  }

  if (cfg.u && cfg.c.watchlist) {
    const watchlistName = displayName ? `${displayName}'s Watchlist` : 'Watchlist';
    catalogs.push({
      type: 'movie',
      id: 'letterboxd-watchlist',
      name: watchlistName,
      extra: [SORT_EXTRA, { name: 'skip', isRequired: false }],
    });
  }

  if (cfg.u && cfg.c.likedFilms) {
    const likedName = displayName ? `${displayName}'s Liked Films` : 'Liked Films';
    catalogs.push({
      type: 'movie',
      id: 'letterboxd-liked-films',
      name: likedName,
      extra: [SORT_EXTRA, { name: 'skip', isRequired: false }],
    });
  }

  for (const listId of cfg.l) {
    catalogs.push({
      type: 'movie',
      id: `letterboxd-list-${listId}`,
      name: listNames?.get(listId) || `List ${listId}`,
      extra: [SORT_EXTRA, { name: 'skip', isRequired: false }],
    });
  }

  // Apply custom catalog names from config
  if (cfg.n) {
    for (const cat of catalogs) {
      const customName = cfg.n[cat.id];
      if (customName) cat.name = customName;
    }
  }

  const namePart = displayName ? ` for ${displayName}` : '';

  return {
    id: 'community.stremboxd',
    version: '1.0.0',
    name: `Stremboxd${namePart}`,
    description: 'Letterboxd catalogs for Stremio. Configure at https://stremboxd.com',
    logo: `${config.PUBLIC_URL}/logo.svg`,
    background: `${config.PUBLIC_URL}/logo.svg`,
    resources: ['catalog'],
    types: ['movie'],
    catalogs,
    behaviorHints: {
      configurable: false,
      configurationRequired: false,
    },
  };
}

/**
 * Generate static manifest (without user lists)
 */
export function generateManifest(user: {
  username: string;
  displayName?: string | null;
}): StremioManifest {
  const displayName = user.displayName || user.username;

  return {
    id: 'community.stremboxd',
    version: '1.0.0',
    name: `Letterboxd for ${displayName}`,
    description: `Your personal Letterboxd ratings and watchlist synced to Stremio. Connected as ${user.username}.`,
    logo: `${config.PUBLIC_URL}/logo.svg`,
    background: `${config.PUBLIC_URL}/background.jpg`,
    resources: [
      'catalog',
      {
        name: 'stream',
        types: ['movie'],
      },
      {
        name: 'meta',
        types: ['movie'],
        idPrefixes: ['tt'],
      },
    ],
    types: ['movie'],
    catalogs: getBaseCatalogs(displayName),
    behaviorHints: {
      configurable: false,
      configurationRequired: false,
    },
    stremioAddonsConfig: STREMIO_ADDONS_CONFIG,
  };
}

/**
 * Generate dynamic manifest with user's lists, filtered by preferences
 */
export function generateDynamicManifest(
  user: {
    username: string;
    displayName?: string | null;
  },
  lists: UserList[],
  preferences?: UserPreferences | null
): StremioManifest {
  const displayName = user.displayName || user.username;
  const baseCatalogs = getBaseCatalogs(displayName);

  let catalogs: StremioCatalog[];

  if (preferences) {
    // Filter base catalogs according to preferences
    const filteredBase = baseCatalogs.filter((cat) => {
      const prefKey = catalogIdMap[cat.id];
      return prefKey ? (preferences.catalogs[prefKey] ?? true) : true;
    });

    // Filter own lists according to preferences
    const filteredOwnLists = lists.filter((l) =>
      preferences.ownLists.includes(l.id)
    );
    const ownListCatalogs = listsToStremioCatalogs(filteredOwnLists);

    // Add external lists from preferences
    const externalListCatalogs: StremioCatalog[] =
      preferences.externalLists.map((ext) => ({
        type: 'movie',
        id: `letterboxd-list-${ext.id}`,
        name: `${ext.name} (${ext.owner})`,
        extra: [SORT_EXTRA, { name: 'skip', isRequired: false }],
      }));

    catalogs = [...filteredBase, ...ownListCatalogs, ...externalListCatalogs];

    // Apply custom catalog names
    if (preferences.catalogNames) {
      for (const cat of catalogs) {
        const customName = preferences.catalogNames[cat.id];
        if (customName) cat.name = customName;
      }
    }
  } else {
    // No preferences: include everything (backwards compatible)
    const listCatalogs = listsToStremioCatalogs(lists);
    catalogs = [...baseCatalogs, ...listCatalogs];
  }

  return {
    id: 'community.stremboxd',
    version: '1.0.0',
    name: `Letterboxd for ${displayName}`,
    description: `Your personal Letterboxd ratings and watchlist synced to Stremio. Connected as ${user.username}.`,
    logo: `${config.PUBLIC_URL}/logo.svg`,
    background: `${config.PUBLIC_URL}/background.jpg`,
    resources: [
      'catalog',
      {
        name: 'stream',
        types: ['movie'],
      },
      {
        name: 'meta',
        types: ['movie'],
        idPrefixes: ['tt'],
      },
    ],
    types: ['movie'],
    catalogs,
    behaviorHints: {
      configurable: false,
      configurationRequired: false,
    },
    stremioAddonsConfig: STREMIO_ADDONS_CONFIG,
  };
}
