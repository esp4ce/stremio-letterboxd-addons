"use client";

import { useEffect, useRef, useState } from "react";
import TransitionLink from "../components/TransitionLink";
import Footer from "../components/Footer";
import ConfigurationModal from "./ConfigurationModal";

const TOAST_DURATION = 3000;
const BACKEND_URL = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:3001";

interface UserPreferences {
  catalogs: { watchlist: boolean; diary: boolean; friends: boolean; popular: boolean; top250: boolean; likedFilms: boolean };
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
  catalogNames?: Record<string, string>;
  catalogOrder?: string[];
}

interface LoginResponse {
  userToken: string;
  manifestUrl: string;
  user: {
    id: string;
    username: string;
    displayName: string | null;
  };
  lists: Array<{
    id: string;
    name: string;
    filmCount: number;
    description?: string;
  }>;
  preferences: UserPreferences | null;
}

interface LoginError {
  error: string;
  code?: string;
}

interface UsernameValidation {
  username: string;
  displayName: string;
  memberId: string;
  lists: Array<{ id: string; name: string; filmCount: number }>;
}

interface PublicConfig {
  u?: string;
  c: { watchlist?: boolean; popular: boolean; top250: boolean; likedFilms?: boolean };
  l: string[];
  r: boolean;
  n?: Record<string, string>;
  w?: string[];
  o?: string[];
}

interface ToastItem {
  id: number;
  message: string;
}

interface ResolvedList {
  id: string;
  name: string;
  owner: string;
  filmCount: number;
}

function getDefaultPreferences(
  lists: LoginResponse["lists"]
): UserPreferences {
  return {
    catalogs: { watchlist: true, diary: true, friends: true, popular: false, top250: true, likedFilms: false },
    ownLists: lists.map((l) => l.id),
    externalLists: [],
  };
}

function encodePublicConfig(config: PublicConfig): string {
  const json = JSON.stringify(config);
  // UTF-8 encode then base64url
  const utf8Bytes = new TextEncoder().encode(json);
  const base64 = btoa(String.fromCharCode(...utf8Bytes));
  return base64
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export default function Configure() {
  const [isLoading, setIsLoading] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [copied, setCopied] = useState(false);
  const [forceMainForm, setForceMainForm] = useState(false);

  // Full auth state
  const [result, setResult] = useState<LoginResponse | null>(null);
  const [showConfig, setShowConfig] = useState(false);
  const [preferences, setPreferences] = useState<UserPreferences | null>(null);
  const [isSavingPrefs, setIsSavingPrefs] = useState(false);

  // Public (username-only) state
  const [usernameValidated, setUsernameValidated] = useState<UsernameValidation | null>(null);
  const [showPublicConfig, setShowPublicConfig] = useState(false);
  const [publicCatalogs, setPublicCatalogs] = useState({ popular: true, top250: true });
  const [publicWatchlist, setPublicWatchlist] = useState(true);
  const [publicOwnLists, setPublicOwnLists] = useState<string[]>([]);
  const [publicLikedFilms, setPublicLikedFilms] = useState(false);
  const [publicLists, setPublicLists] = useState<Array<{ id: string; name: string; owner: string; filmCount: number }>>([]);
  const [publicExternalWatchlists, setPublicExternalWatchlists] = useState<Array<{ username: string; displayName: string }>>([]);
  const [showRatings, setShowRatings] = useState(true);
  const [publicCatalogNames, setPublicCatalogNames] = useState<Record<string, string>>({});
  const [publicCatalogOrder, setPublicCatalogOrder] = useState<string[]>([]);
  const [generatedManifestUrl, setGeneratedManifestUrl] = useState<string | null>(null);

  // Shared
  const [externalListUrl, setExternalListUrl] = useState("");
  const [isResolvingList, setIsResolvingList] = useState(false);

  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const mainModalRef = useRef<HTMLDivElement>(null);
  const arrowShellRef = useRef<HTMLDivElement>(null);
  const mainFormScrollRef = useRef<HTMLDivElement>(null);
  const toastIdRef = useRef(0);
  const [passwordPreview, setPasswordPreview] = useState("");
  const [arrowTopPx, setArrowTopPx] = useState(24);
  const hasPassword = passwordPreview.trim().length > 0;

  useEffect(() => {
    const updateArrowPosition = () => {
      const modalEl = mainModalRef.current;
      const arrowEl = arrowShellRef.current;
      if (!modalEl || !arrowEl) return;

      const modalTop = modalEl.getBoundingClientRect().top;
      const arrowHeight = arrowEl.getBoundingClientRect().height;
      // Keep equal spacing above and below the arrow: top gap == gap to modal.
      const nextTop = Math.max(12, (modalTop - arrowHeight) / 2);
      setArrowTopPx(nextTop);
    };

    updateArrowPosition();

    const resizeObserver = new ResizeObserver(updateArrowPosition);
    if (mainModalRef.current) resizeObserver.observe(mainModalRef.current);
    if (arrowShellRef.current) resizeObserver.observe(arrowShellRef.current);

    const scrollEl = mainFormScrollRef.current;
    window.addEventListener("resize", updateArrowPosition);
    scrollEl?.addEventListener("scroll", updateArrowPosition, { passive: true });

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", updateArrowPosition);
      scrollEl?.removeEventListener("scroll", updateArrowPosition);
    };
  }, []);

  const dismissToast = (id: number) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  };

  const showErrorToast = (message: string) => {
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev, { id, message }]);
    setTimeout(() => dismissToast(id), TOAST_DURATION);
  };

  const formatListResolveError = (message: string) => {
    const normalized = message.replace(/\s+/g, " ").trim();
    const cleaned = normalized
      .replace(/\s*expected format:.*$/i, "")
      .replace(/\s*format attendu:.*$/i, "")
      .trim();

    if (cleaned.length === 0) return "Invalid list URL.";
    return cleaned;
  };

  const showListResolveErrorToast = (error: unknown) => {
    const rawMessage = error instanceof Error ? error.message : "Failed to resolve list";
    showErrorToast(formatListResolveError(rawMessage));
  };

  const resetSessionResults = () => {
    setResult(null);
    setPreferences(null);
    setUsernameValidated(null);
    setGeneratedManifestUrl(null);
    setShowConfig(false);
    setShowPublicConfig(false);
  };

  const returnToMainForm = () => {
    setShowConfig(false);
    setShowPublicConfig(false);
    setForceMainForm(true);
  };

  const resolveList = async (
    endpoint: "/letterboxd/resolve-list" | "/auth/resolve-list-public",
    body: Record<string, string>
  ): Promise<ResolvedList> => {
    const response = await fetch(`${BACKEND_URL}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = await response.json();

    if (!response.ok) {
      const rawError = typeof data?.error === "string" ? data.error : "Failed to resolve list";
      throw new Error(formatListResolveError(rawError));
    }

    return data as ResolvedList;
  };

  const ErrorToastStack = () => {
    if (toasts.length === 0) return null;

    return (
      <div className="pointer-events-none fixed right-6 top-6 z-[90] flex w-[min(92vw,360px)] flex-col gap-2.5">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className="pointer-events-auto animate-fade-in relative overflow-hidden rounded-xl border border-zinc-700/80 bg-black/95 px-4 py-3.5 shadow-2xl"
          >
            <span className="absolute inset-y-0 left-0 w-0.5 bg-red-500/80" />
            <div className="min-w-0 flex-1 pl-2 pr-8">
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
                Error
              </p>
              <p className="mt-1 text-sm leading-relaxed text-zinc-100">{toast.message}</p>
            </div>
            <button
              type="button"
              onClick={() => dismissToast(toast.id)}
              className="absolute right-2.5 top-2.5 text-zinc-500 transition-colors hover:text-zinc-200"
              aria-label="Dismiss error notification"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        ))}
      </div>
    );
  };

  const handleSubmit = async () => {
    const username = usernameRef.current?.value?.trim();
    const password = passwordRef.current?.value?.trim();

    if (!username) {
      showErrorToast("Please enter your Letterboxd username");
      return;
    }

    setIsLoading(true);
    setForceMainForm(false);
    // Reset prior session results so a failed retry cannot show stale success state.
    resetSessionResults();

    try {
      if (password) {
        // Full auth flow
        const response = await fetch(`${BACKEND_URL}/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password }),
        });

        const data = await response.json();

        if (!response.ok) {
          const errorData = data as LoginError;
          throw new Error(errorData.error || "Authentication failed");
        }

        const loginResult = data as LoginResponse;
        setResult(loginResult);

        const defaults = getDefaultPreferences(loginResult.lists);
        const prefs = loginResult.preferences
          ? { ...loginResult.preferences, catalogs: { ...defaults.catalogs, ...loginResult.preferences.catalogs } }
          : defaults;
        setPreferences(prefs);
        setShowConfig(true);
      } else {
        // Public flow (username only)
        const response = await fetch(`${BACKEND_URL}/auth/validate-username`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username }),
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || "Failed to validate username");
        }

        if (!data.valid) {
          showErrorToast("Username not found on Letterboxd");
          return;
        }

        setUsernameValidated({
          username: data.username,
          displayName: data.displayName,
          memberId: data.memberId,
          lists: data.lists,
        });
        setPublicOwnLists(data.lists.map((l: { id: string }) => l.id));
        setShowPublicConfig(true);
      }
    } catch (err) {
      showErrorToast(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setIsLoading(false);
    }
  };

  const handleSavePreferences = async () => {
    if (!result || !preferences) return;

    setIsSavingPrefs(true);
    try {
      const response = await fetch(`${BACKEND_URL}/auth/preferences`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userToken: result.userToken, preferences }),
      });

      if (!response.ok) throw new Error("Failed to save preferences");
      setShowConfig(false);
    } catch {
      showErrorToast("Failed to save preferences. Please try again.");
    } finally {
      setIsSavingPrefs(false);
    }
  };

  const parseWatchlistUrl = (url: string): string | null => {
    const match = url.match(/letterboxd\.com\/([^/?#]+)\/watchlist\/?$/i);
    return match?.[1] ?? null;
  };

  const resolveWatchlistUsername = async (username: string): Promise<{ username: string; displayName: string } | null> => {
    try {
      const response = await fetch(`${BACKEND_URL}/auth/validate-username`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username }),
      });
      const data = await response.json();
      if (!response.ok || !data.valid) return null;
      return { username: data.username, displayName: data.displayName };
    } catch {
      return null;
    }
  };

  const handleResolveExternalList = async () => {
    if (!result || !externalListUrl.trim()) return;

    setIsResolvingList(true);

    try {
      // Detect watchlist URL
      const watchlistUsername = parseWatchlistUrl(externalListUrl.trim());
      if (watchlistUsername) {
        if (result.user.username.toLowerCase() === watchlistUsername.toLowerCase()) {
          showErrorToast("You can't add your own watchlist as external");
          return;
        }
        if (preferences?.externalWatchlists?.some((w) => w.username.toLowerCase() === watchlistUsername.toLowerCase())) {
          showErrorToast("This watchlist has already been added");
          return;
        }
        const resolved = await resolveWatchlistUsername(watchlistUsername);
        if (!resolved) {
          showErrorToast("Username not found on Letterboxd");
          return;
        }
        if (preferences) {
          setPreferences({
            ...preferences,
            externalWatchlists: [...(preferences.externalWatchlists || []), resolved],
          });
        }
        setExternalListUrl("");
        return;
      }

      const resolved = await resolveList("/letterboxd/resolve-list", {
        userToken: result.userToken,
        url: externalListUrl.trim(),
      });

      if (preferences?.externalLists.some((l) => l.id === resolved.id)) {
        showErrorToast("This list has already been added");
        return;
      }

      if (preferences) {
        setPreferences({ ...preferences, externalLists: [...preferences.externalLists, resolved] });
      }
      setExternalListUrl("");
    } catch (err) {
      showListResolveErrorToast(err);
    } finally {
      setIsResolvingList(false);
    }
  };

  const handleResolvePublicList = async () => {
    if (!externalListUrl.trim()) return;

    setIsResolvingList(true);

    try {
      // Detect watchlist URL
      const watchlistUsername = parseWatchlistUrl(externalListUrl.trim());
      if (watchlistUsername) {
        if (usernameValidated && usernameValidated.username.toLowerCase() === watchlistUsername.toLowerCase()) {
          showErrorToast("You can't add your own watchlist as external");
          return;
        }
        if (publicExternalWatchlists.some((w) => w.username.toLowerCase() === watchlistUsername.toLowerCase())) {
          showErrorToast("This watchlist has already been added");
          return;
        }
        const resolved = await resolveWatchlistUsername(watchlistUsername);
        if (!resolved) {
          showErrorToast("Username not found on Letterboxd");
          return;
        }
        setPublicExternalWatchlists((prev) => [...prev, resolved]);
        setExternalListUrl("");
        return;
      }

      const resolved = await resolveList("/auth/resolve-list-public", {
        url: externalListUrl.trim(),
      });

      if (publicLists.some((l) => l.id === resolved.id)) {
        showErrorToast("This list has already been added");
        return;
      }

      setPublicLists((prev) => [...prev, resolved]);
      setExternalListUrl("");
    } catch (err) {
      showListResolveErrorToast(err);
    } finally {
      setIsResolvingList(false);
    }
  };

  const handleInstallPublic = () => {
    const cfg: PublicConfig = {
      c: {
        popular: publicCatalogs.popular,
        top250: publicCatalogs.top250,
      },
      l: publicLists.map((l) => l.id),
      r: showRatings,
    };

    if (publicExternalWatchlists.length > 0) {
      cfg.w = publicExternalWatchlists.map((w) => w.username);
    }

    if (Object.keys(publicCatalogNames).length > 0) {
      cfg.n = publicCatalogNames;
    }

    if (publicCatalogOrder.length > 0) {
      cfg.o = publicCatalogOrder;
    }

    if (usernameValidated) {
      cfg.u = usernameValidated.username;
      cfg.c.watchlist = publicWatchlist;
      cfg.c.likedFilms = publicLikedFilms;
      for (const listId of publicOwnLists) {
        if (!cfg.l.includes(listId)) {
          cfg.l.push(listId);
        }
      }
    }

    const encoded = encodePublicConfig(cfg);
    const manifestUrl = `${BACKEND_URL}/${encoded}/manifest.json`;
    setGeneratedManifestUrl(manifestUrl);
    setShowPublicConfig(false);
  };

  const handleCopy = async () => {
    const url = result?.manifestUrl || generatedManifestUrl;
    if (url) {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleInstallStremio = () => {
    const url = result?.manifestUrl || generatedManifestUrl;
    if (url) {
      const stremioUrl = `stremio://${url.replace(/^https?:\/\//, "")}`;
      window.location.href = stremioUrl;
    }
  };

  const handleReset = () => {
    setToasts([]);
    setForceMainForm(false);
    resetSessionResults();
    setPublicLists([]);
    setPublicExternalWatchlists([]);
    setShowRatings(true);
    setPublicCatalogs({ popular: true, top250: true });
    setPublicWatchlist(true);
    setPublicOwnLists([]);
    setPublicLikedFilms(false);
    setPublicCatalogNames({});
    setPublicCatalogOrder([]);
    setPasswordPreview("");
    if (passwordRef.current) passwordRef.current.value = "";
  };

  // Full auth configuration modal
  if (result && showConfig && preferences && !forceMainForm) {
    return (
      <>
        <ConfigurationModal
          mode="full"
          user={{ username: result.user.username, displayName: result.user.displayName }}
          lists={result.lists}
          onBack={returnToMainForm}
          preferences={preferences}
          onPreferencesChange={setPreferences}
          onSave={handleSavePreferences}
          isSaving={isSavingPrefs}
          externalListUrl={externalListUrl}
          onExternalListUrlChange={setExternalListUrl}
          onAddExternalList={handleResolveExternalList}
          isResolvingList={isResolvingList}
        />
        <ErrorToastStack />
      </>
    );
  }

  // Public configuration modal
  if (showPublicConfig && !forceMainForm) {
    return (
      <>
        <ConfigurationModal
          mode="public"
          user={usernameValidated ? { username: usernameValidated.username, displayName: usernameValidated.displayName } : undefined}
          lists={usernameValidated?.lists || []}
          onBack={returnToMainForm}
          publicCatalogs={publicCatalogs}
          onPublicCatalogsChange={setPublicCatalogs}
          publicWatchlist={publicWatchlist}
          onPublicWatchlistChange={setPublicWatchlist}
          publicLikedFilms={publicLikedFilms}
          onPublicLikedFilmsChange={setPublicLikedFilms}
          publicOwnLists={publicOwnLists}
          onPublicOwnListsChange={setPublicOwnLists}
          publicLists={publicLists}
          onRemovePublicList={(id) => setPublicLists((prev) => prev.filter((l) => l.id !== id))}
          publicExternalWatchlists={publicExternalWatchlists}
          onRemovePublicExternalWatchlist={(username) => setPublicExternalWatchlists((prev) => prev.filter((w) => w.username !== username))}
          showRatings={showRatings}
          onShowRatingsChange={setShowRatings}
          publicCatalogNames={publicCatalogNames}
          onPublicCatalogNamesChange={setPublicCatalogNames}
          publicCatalogOrder={publicCatalogOrder}
          onPublicCatalogOrderChange={setPublicCatalogOrder}
          externalListUrl={externalListUrl}
          onExternalListUrlChange={setExternalListUrl}
          onAddExternalList={handleResolvePublicList}
          isResolvingList={isResolvingList}
          onSave={handleInstallPublic}
          isSaving={false}
        />
        <ErrorToastStack />
      </>
    );
  }

  // Success screen
  const manifestUrl = result?.manifestUrl || generatedManifestUrl;
  if (manifestUrl && !showConfig && !showPublicConfig && !forceMainForm) {
    return (
      <div className="fixed inset-0 flex h-screen w-screen items-center justify-center bg-[#0a0a0a] text-white">
        <div className="w-full max-w-md px-6 sm:px-8">
          <div className="film-grain animate-fade-in relative overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900 p-7 shadow-2xl sm:p-8">
            <div className="mb-5 flex justify-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-green-500/15 ring-1 ring-green-500/25">
                <svg className="h-7 w-7 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
            </div>

            <h2 className="mt-1 text-center text-2xl font-semibold text-white">Addon Ready!</h2>

            <p className="mt-2 text-center text-[13px] text-zinc-400">
              {result
                ? `Welcome, ${result.user.displayName || result.user.username}!`
                : usernameValidated
                  ? `Configured for ${usernameValidated.displayName}`
                  : "Your addon is ready to install"}
            </p>

            <div className="mt-6">
              <button
                type="button"
                onClick={handleInstallStremio}
                className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-white px-4 py-3 text-[15px] font-semibold text-black transition-all hover:bg-zinc-200 focus:outline-none focus:ring-2 focus:ring-white focus:ring-offset-2 focus:ring-offset-zinc-900"
              >
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                Install in Stremio
              </button>

              <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-800/35 p-3">
                <label className="block text-[10px] uppercase tracking-[0.12em] text-zinc-500">Manifest URL</label>
                <div className="mt-2 flex gap-2">
                  <input
                    type="text"
                    readOnly
                    value={manifestUrl}
                    className="block h-10 w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 text-[12px] text-zinc-300 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={handleCopy}
                    className="h-10 flex-shrink-0 rounded-lg border border-zinc-700 bg-zinc-800 px-3 text-xs text-zinc-300 transition-colors hover:bg-zinc-700"
                  >
                    {copied ? "✓" : "Copy"}
                  </button>
                </div>
              </div>

              <div className="mt-4 flex items-center justify-center gap-3 text-xs text-zinc-500">
                <button
                  type="button"
                  onClick={() => {
                    setForceMainForm(false);
                    if (result) setShowConfig(true);
                    else setShowPublicConfig(true);
                  }}
                  className="transition-colors hover:text-zinc-300"
                >
                  Reconfigure
                </button>
                <span className="text-zinc-700">|</span>
                <button
                  type="button"
                  onClick={handleReset}
                  className="transition-colors hover:text-zinc-300"
                >
                  Start over
                </button>
              </div>
            </div>

            <div className="mt-5 border-t border-zinc-800 pt-4">
              <p className="text-center text-[11px] font-light leading-relaxed text-zinc-500">
                For the best experience, use{" "}
                <a
                  href="https://stremio-addon-manager.vercel.app/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-zinc-300 underline decoration-zinc-600 underline-offset-2 transition-colors hover:text-white hover:decoration-zinc-400"
                >
                  Stremio Addon Manager
                </a>{" "}
                to move this addon to the top of your list so Letterboxd info appears first.
              </p>
            </div>
          </div>
        </div>

        <Footer />
        <ErrorToastStack />
      </div>
    );
  }

  // Main form
  return (
    <div ref={mainFormScrollRef} className="fixed inset-0 overflow-y-auto bg-[#0a0a0a] text-white">
      <div className="flex min-h-screen w-full flex-col items-center justify-center px-6 py-10 sm:px-8 sm:py-12">
        <div
          ref={arrowShellRef}
          className="fixed left-1/2 z-20 -translate-x-1/2"
          style={{ top: `${arrowTopPx}px` }}
        >
          <TransitionLink
            href="/"
            direction="down"
            className="flex h-[clamp(2.875rem,3vw,4rem)] w-[clamp(2.875rem,3vw,4rem)] items-center justify-center rounded-full bg-white transition-all hover:scale-110 hover:bg-zinc-200 focus:outline-none focus:ring-2 focus:ring-white focus:ring-offset-2 focus:ring-offset-[#0a0a0a]"
            ariaLabel="Back to home"
          >
            <svg className="h-[clamp(1.0625rem,1.2vw,1.625rem)] w-[clamp(1.0625rem,1.2vw,1.625rem)] text-black" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
            </svg>
          </TransitionLink>
        </div>

        <div className="w-full max-w-lg">
          <div ref={mainModalRef} className="film-grain animate-fade-in relative w-full overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900 p-7 shadow-2xl sm:p-8">
            <h2
              className="text-center text-2xl font-semibold text-white sm:text-3xl"
            >
              Configure your addon
            </h2>
            <p className="mx-auto mt-2.5 max-w-lg text-center text-xs leading-relaxed text-zinc-400 ">
              Password is optional for diary, friends activity and full Letterboxd controls.
            </p>

            <form
              className="mt-7 space-y-5"
              onSubmit={(e) => {
                e.preventDefault();
                handleSubmit();
              }}
            >
              <div>
                <label htmlFor="username" className="block text-[13px] font-medium text-zinc-300">
                  Username
                  <span className="ml-1 text-xs text-zinc-500">*</span>
                </label>
                <input
                  ref={usernameRef}
                  type="text"
                  id="username"
                  name="username"
                  autoComplete="username"
                  placeholder="your-username"
                  disabled={isLoading}
                  className="mt-2 block w-full rounded-xl border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-sm text-white placeholder-zinc-500 transition-colors focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500 disabled:cursor-not-allowed disabled:opacity-50"
                />
              </div>

              <div>
                <div className="flex items-center justify-between gap-3">
                  <label htmlFor="password" className="block text-[13px] font-medium text-zinc-300">
                    Password
                  </label>
                </div>
                <input
                  ref={passwordRef}
                  type="password"
                  id="password"
                  name="password"
                  autoComplete="current-password"
                  onChange={(e) => setPasswordPreview(e.target.value)}
                  placeholder="**************"
                  disabled={isLoading}
                  className="mt-2 block w-full rounded-xl border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-sm text-white placeholder-zinc-500 transition-colors focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500 disabled:cursor-not-allowed disabled:opacity-50"
                />
              </div>

              <div className="rounded-xl border border-zinc-800 bg-zinc-800/30 px-3.5 py-2.5">
                <p className="text-[10px] uppercase tracking-[0.14em] text-zinc-500">Mode</p>
                <p className="mt-1 text-[13px] text-zinc-200">
                  {hasPassword ? "Full access" : "Username only"}
                </p>
                <p className="mt-1 text-xs text-zinc-500">
                  {hasPassword
                    ? "Includes diary, friends activity and all Letterboxd actions from Stremio."
                    : "Includes popular films, Top 250, watchlist and lists."}
                </p>
              </div>

              <button
                type="submit"
                disabled={isLoading}
                className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl bg-white px-4 py-3 text-[15px] font-semibold text-black transition-all hover:bg-zinc-200 focus:outline-none focus:ring-2 focus:ring-white focus:ring-offset-2 focus:ring-offset-zinc-900 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {isLoading ? (
                  <>
                    <svg className="h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    Connecting...
                  </>
                ) : (
                  "Generate my addon"
                )}
              </button>

              <p className="cursor-default text-center text-xs text-zinc-500">
                Your password is only used to authenticate with Letterboxd.
                <br />
                We store an encrypted refresh token, not your raw password.
              </p>
            </form>
          </div>
        </div>
      </div>
      <Footer />
      <ErrorToastStack />
    </div>
  );
}

