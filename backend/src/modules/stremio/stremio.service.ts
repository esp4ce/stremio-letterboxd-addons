import { config } from '../../config/index.js';
import type { UserList } from '../letterboxd/letterboxd.client.js';
import type { UserPreferences } from '../../db/repositories/user.repository.js';

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

/**
 * Generate base catalogs for a user
 */
function getBaseCatalogs(displayName: string): StremioCatalog[] {
  return [
    {
      type: 'movie',
      id: 'letterboxd-watchlist',
      name: `${displayName}'s Watchlist`,
      extra: [{ name: 'skip', isRequired: false }],
    },
    {
      type: 'movie',
      id: 'letterboxd-diary',
      name: `${displayName}'s Recent Diary`,
      extra: [{ name: 'skip', isRequired: false }],
    },
    {
      type: 'movie',
      id: 'letterboxd-friends',
      name: `${displayName}'s Friends Activity`,
      extra: [{ name: 'skip', isRequired: false }],
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
    extra: [{ name: 'skip', isRequired: false }],
  }));
}

/**
 * Generate base manifest for stremio-addons.net submission
 * This is a static manifest without user-specific data
 */
export function generateBaseManifest(): StremioManifest {
  return {
    id: 'community.stremboxd',
    version: '1.0.0',
    name: 'Stremboxd',
    description: 'Sync your Letterboxd ratings, watchlist, and activity to Stremio. Configure at https://stremboxd.com',
    logo: `${config.PUBLIC_URL}/logo.svg`,
    background: `${config.PUBLIC_URL}/logo.svg`,
    resources: [
      'catalog',
      {
        name: 'stream',
        types: ['movie'],
      },
    ],
    types: ['movie'],
    catalogs: [
      {
        type: 'movie',
        id: 'letterboxd-watchlist',
        name: 'Watchlist',
      },
      {
        type: 'movie',
        id: 'letterboxd-diary',
        name: 'Recent Diary',
      },
      {
        type: 'movie',
        id: 'letterboxd-friends',
        name: 'Friends Activity',
      },
    ],
    behaviorHints: {
      configurable: false,
      configurationRequired: false,
    },
    stremioAddonsConfig: STREMIO_ADDONS_CONFIG,
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
        extra: [{ name: 'skip', isRequired: false }],
      }));

    catalogs = [...filteredBase, ...ownListCatalogs, ...externalListCatalogs];
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
