"use client";

import { useState } from "react";

interface UserPreferences {
  catalogs: { watchlist: boolean; diary: boolean; friends: boolean; popular: boolean; top250: boolean; likedFilms: boolean };
  ownLists: string[];
  externalLists: Array<{
    id: string;
    name: string;
    owner: string;
    filmCount: number;
  }>;
  showActions?: boolean;
  showRatings?: boolean;
  catalogNames?: Record<string, string>;
}

interface BaseProps {
  user?: { username: string; displayName: string | null };
  lists: Array<{ id: string; name: string; filmCount: number }>;
  onBack: () => void;
  onSave: () => void;
  isSaving: boolean;
  externalListUrl: string;
  onExternalListUrlChange: (url: string) => void;
  onAddExternalList: () => void;
  isResolvingList: boolean;
}

interface FullModeProps extends BaseProps {
  mode: "full";
  preferences: UserPreferences;
  onPreferencesChange: (prefs: UserPreferences) => void;
}

interface PublicModeProps extends BaseProps {
  mode: "public";
  publicCatalogs: { popular: boolean; top250: boolean };
  onPublicCatalogsChange: (cats: { popular: boolean; top250: boolean }) => void;
  publicWatchlist: boolean;
  onPublicWatchlistChange: (val: boolean) => void;
  publicLikedFilms: boolean;
  onPublicLikedFilmsChange: (val: boolean) => void;
  publicOwnLists: string[];
  onPublicOwnListsChange: (ids: string[]) => void;
  publicLists: Array<{ id: string; name: string; owner: string; filmCount: number }>;
  onRemovePublicList: (id: string) => void;
  showRatings: boolean;
  onShowRatingsChange: (val: boolean) => void;
  publicCatalogNames: Record<string, string>;
  onPublicCatalogNamesChange: (names: Record<string, string>) => void;
}

type ConfigurationModalProps = FullModeProps | PublicModeProps;

const PENCIL_ICON = "M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z";

function EditableName({
  catalogId,
  displayName,
  editingCatalogId,
  editingName,
  onEditingNameChange,
  onStartEditing,
  onSave,
  onCancel,
  stopPropagation,
}: {
  catalogId: string;
  displayName: string;
  editingCatalogId: string | null;
  editingName: string;
  onEditingNameChange: (v: string) => void;
  onStartEditing: () => void;
  onSave: () => void;
  onCancel: () => void;
  stopPropagation?: boolean;
}) {
  if (editingCatalogId === catalogId) {
    return (
      <input
        type="text"
        value={editingName}
        onChange={(e) => onEditingNameChange(e.target.value)}
        onBlur={onSave}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSave();
          if (e.key === "Escape") onCancel();
        }}
        autoFocus
        className="w-full rounded border border-zinc-600 bg-zinc-800 px-2 py-0.5 text-[13px] text-white focus:border-zinc-400 focus:outline-none"
      />
    );
  }
  return (
    <div className="flex items-center gap-1.5">
      <p className="truncate text-[13px] font-medium text-white">{displayName}</p>
      <button
        type="button"
        onClick={(e) => {
          if (stopPropagation) e.stopPropagation();
          onStartEditing();
        }}
        className="flex-shrink-0 text-zinc-600 transition-colors hover:text-zinc-300"
      >
        <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={PENCIL_ICON} />
        </svg>
      </button>
    </div>
  );
}

function Toggle({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`relative h-6 w-11 flex-shrink-0 rounded-full transition-colors ${
        enabled ? "bg-white" : "bg-zinc-700"
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 h-5 w-5 rounded-full transition-transform ${
          enabled ? "translate-x-5 bg-black" : "translate-x-0 bg-zinc-400"
        }`}
      />
    </button>
  );
}

export default function ConfigurationModal(props: ConfigurationModalProps) {
  const { mode, user, lists, onBack, onSave, isSaving, externalListUrl, onExternalListUrlChange, onAddExternalList, isResolvingList } = props;

  const isPublic = mode === "public";
  const hasUsername = !!user;

  // Catalog name editing state
  const [editingCatalogId, setEditingCatalogId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  const getCatalogDisplayName = (catalogId: string, defaultName: string): string => {
    if (isPublic) {
      return (props as PublicModeProps).publicCatalogNames[catalogId] || defaultName;
    }
    const p = props as FullModeProps;
    return p.preferences.catalogNames?.[catalogId] || defaultName;
  };

  const startEditingCatalogName = (catalogId: string, currentName: string) => {
    setEditingCatalogId(catalogId);
    setEditingName(currentName);
  };

  const saveCatalogName = (catalogId: string, defaultName: string) => {
    const trimmed = editingName.trim();
    const computeNames = (current: Record<string, string> | undefined): Record<string, string> => {
      const newNames = { ...current };
      if (!trimmed || trimmed === defaultName) {
        delete newNames[catalogId];
      } else {
        newNames[catalogId] = trimmed;
      }
      return newNames;
    };

    if (isPublic) {
      const p = props as PublicModeProps;
      p.onPublicCatalogNamesChange(computeNames(p.publicCatalogNames));
    } else {
      const p = props as FullModeProps;
      const newNames = computeNames(p.preferences.catalogNames);
      p.onPreferencesChange({ ...p.preferences, catalogNames: Object.keys(newNames).length > 0 ? newNames : undefined });
    }
    setEditingCatalogId(null);
  };

  // Catalog toggle helpers
  const getCatalogEnabled = (key: string): boolean => {
    if (isPublic) {
      const p = props as PublicModeProps;
      if (key === "popular") return p.publicCatalogs.popular;
      if (key === "top250") return p.publicCatalogs.top250;
      if (key === "watchlist") return hasUsername ? p.publicWatchlist : false;
      if (key === "likedFilms") return hasUsername ? p.publicLikedFilms : false;
      return false;
    }
    const p = props as FullModeProps;
    return p.preferences.catalogs[key as keyof UserPreferences["catalogs"]] ?? false;
  };

  const toggleCatalog = (key: string) => {
    if (isPublic) {
      const p = props as PublicModeProps;
      if (key === "popular" || key === "top250") {
        p.onPublicCatalogsChange({ ...p.publicCatalogs, [key]: !p.publicCatalogs[key] });
      }
      if (key === "watchlist" && hasUsername) {
        p.onPublicWatchlistChange(!p.publicWatchlist);
      }
      if (key === "likedFilms" && hasUsername) {
        p.onPublicLikedFilmsChange(!p.publicLikedFilms);
      }
      return;
    }
    const p = props as FullModeProps;
    p.onPreferencesChange({
      ...p.preferences,
      catalogs: {
        ...p.preferences.catalogs,
        [key]: !p.preferences.catalogs[key as keyof UserPreferences["catalogs"]],
      },
    });
  };

  const toggleOwnList = (listId: string) => {
    if (isPublic) {
      const p = props as PublicModeProps;
      const current = p.publicOwnLists;
      const updated = current.includes(listId)
        ? current.filter((id) => id !== listId)
        : [...current, listId];
      p.onPublicOwnListsChange(updated);
      return;
    }
    const p = props as FullModeProps;
    const current = p.preferences.ownLists;
    const updated = current.includes(listId)
      ? current.filter((id) => id !== listId)
      : [...current, listId];
    p.onPreferencesChange({ ...p.preferences, ownLists: updated });
  };

  const selectAllOwnLists = () => {
    const allIds = lists.map((l) => l.id);
    if (isPublic) {
      (props as PublicModeProps).onPublicOwnListsChange(allIds);
      return;
    }
    const p = props as FullModeProps;
    p.onPreferencesChange({ ...p.preferences, ownLists: allIds });
  };

  const deselectAllOwnLists = () => {
    if (isPublic) {
      (props as PublicModeProps).onPublicOwnListsChange([]);
      return;
    }
    const p = props as FullModeProps;
    p.onPreferencesChange({ ...p.preferences, ownLists: [] });
  };

  const isOwnListSelected = (listId: string): boolean => {
    if (isPublic) return (props as PublicModeProps).publicOwnLists.includes(listId);
    return (props as FullModeProps).preferences.ownLists.includes(listId);
  };

  const removeExternalList = (listId: string) => {
    if (isPublic) {
      (props as PublicModeProps).onRemovePublicList(listId);
      return;
    }
    const p = props as FullModeProps;
    p.onPreferencesChange({
      ...p.preferences,
      externalLists: p.preferences.externalLists.filter((l) => l.id !== listId),
    });
  };

  // Build catalog items based on mode
  const catalogKeyToId: Record<string, string> = {
    watchlist: "letterboxd-watchlist",
    diary: "letterboxd-diary",
    friends: "letterboxd-friends",
    likedFilms: "letterboxd-liked-films",
    popular: "letterboxd-popular",
    top250: "letterboxd-top250",
  };

  type CatalogItem = { key: string; catalogId: string; label: string; description: string; available: boolean; featured?: boolean };
  const catalogItems: CatalogItem[] = [];

  if (!isPublic) {
    catalogItems.push({ key: "watchlist", catalogId: catalogKeyToId["watchlist"]!, label: "Watchlist", description: "Films you want to watch", available: true, featured: true });
    catalogItems.push({ key: "diary", catalogId: catalogKeyToId["diary"]!, label: "Diary", description: "Your recently watched films", available: true });
    catalogItems.push({ key: "friends", catalogId: catalogKeyToId["friends"]!, label: "Friends Activity", description: "What your friends are watching", available: true });
    catalogItems.push({ key: "likedFilms", catalogId: catalogKeyToId["likedFilms"]!, label: "Liked Films", description: "Films you have liked", available: true });
  }

  catalogItems.push({ key: "popular", catalogId: catalogKeyToId["popular"]!, label: "Popular This Week", description: "Trending films on Letterboxd", available: true });
  catalogItems.push({ key: "top250", catalogId: catalogKeyToId["top250"]!, label: "Top 250 Narrative Features", description: "Official Top 250 by Dave", available: true });

  if (isPublic && hasUsername) {
    catalogItems.push({ key: "watchlist", catalogId: catalogKeyToId["watchlist"]!, label: "Watchlist", description: "Films you want to watch", available: true, featured: true });
    catalogItems.push({ key: "likedFilms", catalogId: catalogKeyToId["likedFilms"]!, label: "Liked Films", description: "Films you have liked", available: true });
  }

  // External lists to display
  const externalListsToShow = isPublic
    ? (props as PublicModeProps).publicLists
    : (props as FullModeProps).preferences.externalLists;

  const ownListCount = isPublic
    ? (props as PublicModeProps).publicOwnLists.length
    : (props as FullModeProps).preferences.ownLists.length;

  return (
    <div className="fixed inset-0 flex h-screen w-screen items-center justify-center bg-[#0a0a0a] px-4 py-5 text-white sm:px-6">
      <div className="w-full max-w-3xl 2xl:max-w-4xl">
        <div className="film-grain animate-fade-in modal-scroll relative max-h-[88vh] overflow-y-auto rounded-2xl border border-zinc-800 bg-zinc-900 p-5 shadow-2xl sm:p-6 lg:p-7">
          {/* Header */}
          <div className="flex items-center justify-between gap-4">
            <button
              type="button"
              onClick={onBack}
              className="group inline-flex items-center gap-2 text-[12px] text-zinc-400 transition-colors hover:text-zinc-200"
            >
              <svg className="h-3.5 w-3.5 transition-transform group-hover:-translate-x-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              Back
            </button>

            <p className="text-[12px] text-zinc-500">
              {user ? (
                <span className="text-zinc-300">{user.displayName || user.username}</span>
              ) : (
                "Public mode"
              )}
            </p>
          </div>

          {/* Catalogs */}
          <div className="mt-7">
            <h3 className="text-[11px] font-medium uppercase tracking-[0.16em] text-zinc-400">Catalogs</h3>
            <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              {catalogItems.map((item) => (
                <div
                  key={item.key}
                  className={`flex items-center justify-between rounded-lg bg-zinc-800/35 px-3.5 py-3 transition-colors hover:bg-zinc-800/55 ${
                    item.featured ? "sm:col-span-2" : ""
                  }`}
                >
                  <div className="min-w-0 flex-1 pr-3">
                    <EditableName
                      catalogId={item.catalogId}
                      displayName={getCatalogDisplayName(item.catalogId, item.label)}
                      editingCatalogId={editingCatalogId}
                      editingName={editingName}
                      onEditingNameChange={setEditingName}
                      onStartEditing={() => startEditingCatalogName(item.catalogId, getCatalogDisplayName(item.catalogId, item.label))}
                      onSave={() => saveCatalogName(item.catalogId, item.label)}
                      onCancel={() => setEditingCatalogId(null)}
                    />
                    <p className="text-[11px] leading-relaxed text-zinc-500">{item.description}</p>
                  </div>
                  <Toggle
                    enabled={getCatalogEnabled(item.key)}
                    onToggle={() => toggleCatalog(item.key)}
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Display Options */}
          {isPublic ? (
            <div className="mt-7">
              <h3 className="text-[11px] font-medium uppercase tracking-[0.16em] text-zinc-400">Display Options</h3>
              <div className="mt-3 flex items-center justify-between rounded-lg bg-zinc-800/35 px-3.5 py-3">
                <div>
                  <p className="text-[13px] font-medium text-white">Poster Ratings</p>
                  <p className="mt-0.5 text-[11px] text-zinc-500">Show Letterboxd ratings on poster images</p>
                </div>
                <Toggle
                  enabled={(props as PublicModeProps).showRatings}
                  onToggle={() => (props as PublicModeProps).onShowRatingsChange(!(props as PublicModeProps).showRatings)}
                />
              </div>
            </div>
          ) : (
            <div className="mt-7">
              <h3 className="text-[11px] font-medium uppercase tracking-[0.16em] text-zinc-400">Display Options</h3>
              <div className="mt-3 space-y-2">
                <div className="flex items-center justify-between rounded-lg bg-zinc-800/35 px-3.5 py-3">
                  <div>
                    <p className="text-[13px] font-medium text-white">Poster Ratings</p>
                    <p className="mt-0.5 text-[11px] text-zinc-500">Show Letterboxd ratings on poster images</p>
                  </div>
                  <Toggle
                    enabled={(props as FullModeProps).preferences.showRatings !== false}
                    onToggle={() => {
                      const p = props as FullModeProps;
                      p.onPreferencesChange({ ...p.preferences, showRatings: p.preferences.showRatings === false });
                    }}
                  />
                </div>
                <div className="flex items-center justify-between rounded-lg bg-zinc-800/35 px-3.5 py-3">
                  <div>
                    <p className="text-[13px] font-medium text-white">Letterboxd Actions</p>
                    <p className="mt-0.5 text-[11px] text-zinc-500">Show rate, watched, liked and watchlist buttons in Stremio</p>
                  </div>
                  <Toggle
                    enabled={(props as FullModeProps).preferences.showActions !== false}
                    onToggle={() => {
                      const p = props as FullModeProps;
                      p.onPreferencesChange({ ...p.preferences, showActions: p.preferences.showActions === false });
                    }}
                  />
                </div>
              </div>
            </div>
          )}

          {/* External lists */}
          <div className="mt-7">
            <h3 className="text-[11px] font-medium uppercase tracking-[0.16em] text-zinc-400">
              {isPublic ? "Public Lists" : "External Lists"}
            </h3>
            <p className="mt-1 text-[11px] text-zinc-500">Paste a Letterboxd list URL</p>

            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <input
                type="text"
                value={externalListUrl}
                onChange={(e) => onExternalListUrlChange(e.target.value)}
                placeholder="letterboxd.com/user/list/name/"
                className="block w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 text-[13px] text-white placeholder-zinc-500 transition-colors focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    onAddExternalList();
                  }
                }}
              />
              <button
                type="button"
                onClick={onAddExternalList}
                disabled={isResolvingList || !externalListUrl.trim()}
                className="flex-shrink-0 rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-[13px] text-zinc-300 transition-colors hover:bg-zinc-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isResolvingList ? "..." : "Add"}
              </button>
            </div>

            {externalListsToShow.length > 0 && (
              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {externalListsToShow.map((list) => {
                  const extCatId = `letterboxd-list-${list.id}`;
                  const extDefaultName = `${list.name} (${list.owner})`;
                  return (
                    <div
                      key={list.id}
                      className="flex items-center gap-3 rounded-lg bg-zinc-800/35 px-3.5 py-2.5"
                    >
                      <div className="min-w-0 flex-1">
                        <EditableName
                          catalogId={extCatId}
                          displayName={getCatalogDisplayName(extCatId, list.name)}
                          editingCatalogId={editingCatalogId}
                          editingName={editingName}
                          onEditingNameChange={setEditingName}
                          onStartEditing={() => startEditingCatalogName(extCatId, getCatalogDisplayName(extCatId, list.name))}
                          onSave={() => saveCatalogName(extCatId, extDefaultName)}
                          onCancel={() => setEditingCatalogId(null)}
                        />
                        <p className="text-[11px] text-zinc-500">
                          by {list.owner} &middot; {list.filmCount} films
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeExternalList(list.id)}
                        className="flex-shrink-0 text-zinc-500 transition-colors hover:text-zinc-300"
                      >
                        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* User lists */}
          {hasUsername && lists.length > 0 && (
            <div className="mt-7">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-[11px] font-medium uppercase tracking-[0.16em] text-zinc-400">
                  {user?.displayName || user?.username}&apos;s Lists
                </h3>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-zinc-500">
                    {ownListCount} / {lists.length}
                  </span>
                  <button
                    type="button"
                    onClick={selectAllOwnLists}
                    className="text-[11px] text-zinc-500 transition-colors hover:text-zinc-200"
                  >
                    All
                  </button>
                  <span className="text-[11px] text-zinc-700">/</span>
                  <button
                    type="button"
                    onClick={deselectAllOwnLists}
                    className="text-[11px] text-zinc-500 transition-colors hover:text-zinc-200"
                  >
                    None
                  </button>
                </div>
              </div>
              <div className="config-scroll mt-3 grid max-h-[20vh] grid-cols-1 gap-2 overflow-y-auto pr-1 sm:grid-cols-2 lg:grid-cols-3">
                {lists.map((list) => {
                  const ownCatId = `letterboxd-list-${list.id}`;
                  return (
                    <div
                      key={list.id}
                      className="flex cursor-pointer items-center gap-3 rounded-lg bg-zinc-800/35 px-3.5 py-2.5 transition-colors hover:bg-zinc-800/55"
                    >
                      <input
                        type="checkbox"
                        checked={isOwnListSelected(list.id)}
                        onChange={() => toggleOwnList(list.id)}
                        className="h-4 w-4 rounded border-zinc-600 bg-zinc-700 text-white accent-white"
                      />
                      <div className="min-w-0 flex-1">
                        <EditableName
                          catalogId={ownCatId}
                          displayName={getCatalogDisplayName(ownCatId, list.name)}
                          editingCatalogId={editingCatalogId}
                          editingName={editingName}
                          onEditingNameChange={setEditingName}
                          onStartEditing={() => startEditingCatalogName(ownCatId, getCatalogDisplayName(ownCatId, list.name))}
                          onSave={() => saveCatalogName(ownCatId, list.name)}
                          onCancel={() => setEditingCatalogId(null)}
                          stopPropagation
                        />
                      </div>
                      <span className="flex-shrink-0 text-[11px] text-zinc-500">{list.filmCount}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* No lists placeholder */}
          {hasUsername && lists.length === 0 && (
            <div className="mt-7">
              <h3 className="text-[11px] font-medium uppercase tracking-[0.16em] text-zinc-400">Your Lists</h3>
              <p className="mt-3 text-[13px] text-zinc-500">No lists found on this account</p>
            </div>
          )}

          {/* Save Button */}
          <div className="mt-8">
            <button
              type="button"
              onClick={onSave}
              disabled={isSaving}
              className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-white px-4 py-3 text-[15px] font-semibold text-black transition-all hover:bg-zinc-200 focus:outline-none focus:ring-2 focus:ring-white focus:ring-offset-2 focus:ring-offset-zinc-900 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {isSaving ? (
                <>
                  <svg className="h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                  </svg>
                  Saving...
                </>
              ) : (
                <>
                  <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  {isPublic ? "Generate & Install" : "Save & Install"}
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
