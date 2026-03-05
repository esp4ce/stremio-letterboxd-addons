export interface UserPreferences {
  catalogs: {
    watchlist: boolean;
    diary: boolean;
    friends: boolean;
    popular: boolean;
    top250: boolean;
    likedFilms: boolean;
    recommended: boolean;
  };
  ownLists: string[];
  externalLists: Array<{
    id: string;
    name: string;
    owner: string;
    filmCount: number;
  }>;
  externalWatchlists?: Array<{ username: string; displayName: string }>;
  showActions?: boolean;
  showRatings?: boolean;
  showReviews?: boolean;
  catalogNames?: Record<string, string>;
  catalogOrder?: string[];
}
