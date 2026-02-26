"use client";

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getToken, clearToken, fetchWithAuth, isTokenExpired } from '@/lib/dashboard-auth';
import { OverviewStats } from '@/components/dashboard/OverviewStats';
import { SystemHealth } from '@/components/dashboard/SystemHealth';
import { DatabaseStats } from '@/components/dashboard/DatabaseStats';
import { TopUsersTable } from '@/components/dashboard/TopUsersTable';
import { CatalogsChart } from '@/components/dashboard/CatalogsChart';
import { RecentActivity } from '@/components/dashboard/RecentActivity';
import { PeakHoursChart } from '@/components/dashboard/PeakHoursChart';

interface DetailedHealthData {
  system: {
    uptime: number;
    memory: {
      used: number;
      total: number;
      percentage: number;
      warning: boolean;
    };
    cpu: {
      user: number;
      system: number;
      percentage: number;
    };
  };
  database: {
    sizeBytes: number;
    sizeMB: string;
    totalEvents: number;
    oldestEvent: string | null;
    newestEvent: string | null;
  };
  caches: Record<string, { size: number; max: number }>;
  alerts: Array<{ level: 'warning' | 'critical'; message: string }>;
}

interface TopUsersData {
  overview: {
    totalUsers: number;
    activeUsers7d: number;
    activeUsers30d: number;
    totalEvents: number;
    avgEventsPerUser: number;
    newUsersLast7d: number;
    newUsersLast30d: number;
  };
  topUsers: Array<{
    userId: string;
    username: string | null;
    displayName: string | null;
    totalEvents: number;
    lastActivity: string;
    firstSeen: string;
    breakdown: {
      catalog_views: number;
      streams: number;
      actions: number;
      logins: number;
    };
  }>;
}

interface MetricsSummaryData {
  total_events: number;
  total_users: number;
  events_by_type: Record<string, number>;
  daily_events: Array<{ date: string; count: number }>;
  daily_active_users: Array<{ date: string; count: number }>;
  top_catalogs: Array<{ catalog: string; count: number }>;
  growth?: {
    eventsLast7Days: number;
    eventsLast30Days: number;
    newUsersLast7Days: number;
    avgEventsPerDay: number;
    projectedDbSizeIn30Days: string;
  };
  database?: {
    totalEvents: number;
    oldestEvent: string | null;
    sizeBytes: number;
    sizeMB: string;
  };
}

interface AnonymousData {
  uniqueUsers: { authenticated: number; anonymous: number; total: number };
  peakHours: Array<{ hour: number; count: number }>;
  survival: { avgDays: number; medianDays: number };
  funnel: { manifestViews: number; catalogFetches: number; authenticated: number };
  topFilms: Array<{ imdbId: string; title?: string; count: number }>;
  topLists: Array<{ listId: string; listName?: string; count: number }>;
  actions: Array<{ action: string; count: number }>;
  topActionedFilms: Array<{ filmId: string; imdbId?: string; title?: string; action: string; count: number }>;
  catalogBreakdown: Array<{ catalog: string; tier: string; count: number }>;
}

type DashboardTab = 'overview' | 'insights' | 'audience';

export default function Dashboard() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [healthData, setHealthData] = useState<DetailedHealthData | null>(null);
  const [usersData, setUsersData] = useState<TopUsersData | null>(null);
  const [metricsData, setMetricsData] = useState<MetricsSummaryData | null>(null);
  const [anonymousData, setAnonymousData] = useState<AnonymousData | null>(null);
  const [activeTab, setActiveTab] = useState<DashboardTab>('overview');

  const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3001';

  useEffect(() => {
    // Check authentication
    const token = getToken();
    if (!token || isTokenExpired(token)) {
      router.push('/dashboard/login');
      return;
    }

    // Fetch initial data
    fetchDashboardData();

    // Auto-refresh every 10 seconds
    const interval = setInterval(() => {
      fetchDashboardData();
    }, 10000);

    return () => clearInterval(interval);
  }, [router, backendUrl]);

  const fetchDashboardData = async () => {
    try {
      const [healthRes, usersRes, metricsRes, anonRes] = await Promise.all([
        fetchWithAuth(`${backendUrl}/health/detailed`),
        fetchWithAuth(`${backendUrl}/metrics/users?days=30&limit=10`),
        fetchWithAuth(`${backendUrl}/metrics/summary?days=30`),
        fetchWithAuth(`${backendUrl}/metrics/anonymous?days=30`),
      ]);

      if (!healthRes.ok || !usersRes.ok || !metricsRes.ok) {
        if (healthRes.status === 401 || usersRes.status === 401 || metricsRes.status === 401) {
          clearToken();
          router.push('/dashboard/login');
          return;
        }
        throw new Error('Failed to fetch dashboard data');
      }

      const health = (await healthRes.json()) as DetailedHealthData;
      const users = (await usersRes.json()) as TopUsersData;
      const metrics = (await metricsRes.json()) as MetricsSummaryData;
      const anonymous = anonRes.ok ? (await anonRes.json()) as AnonymousData : null;

      setHealthData(health);
      setUsersData(users);
      setMetricsData(metrics);
      setAnonymousData(anonymous);
      setError('');
      setLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dashboard');
      setLoading(false);
    }
  };

  const handleLogout = () => {
    clearToken();
    router.push('/dashboard/login');
  };

  if (loading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-[#0a0a0a]">
        <div className="film-grain pointer-events-none fixed inset-0 opacity-[0.015]" />
        <div className="text-zinc-400">Loading dashboard...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-[#0a0a0a]">
        <div className="film-grain pointer-events-none fixed inset-0 opacity-[0.015]" />
        <div className="space-y-4 text-center">
          <div className="text-red-400">{error}</div>
          <button
            onClick={() => fetchDashboardData()}
            className="rounded-lg bg-white px-4 py-2 text-black hover:bg-zinc-200"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] p-4 text-white md:p-8">
      <div className="film-grain pointer-events-none fixed inset-0 opacity-[0.015]" />

      <div className="relative z-10 mx-auto max-w-7xl space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-semibold">Monitoring Dashboard</h1>
            <p className="text-sm text-zinc-400">
              Auto-refresh every 10 seconds
            </p>
          </div>
          <button
            onClick={handleLogout}
            className="rounded-lg bg-zinc-900/50 px-4 py-2 text-sm text-zinc-300 ring-1 ring-zinc-800 transition hover:bg-zinc-800/50"
          >
            Log Out
          </button>
        </div>

        {/* Alerts */}
        {healthData && healthData.alerts.length > 0 && (
          <div className="space-y-2">
            {healthData.alerts.map((alert, idx) => (
              <div
                key={idx}
                className={`rounded-lg px-4 py-3 ring-1 ${
                  alert.level === 'critical'
                    ? 'bg-red-500/10 text-red-400 ring-red-500/20'
                    : 'bg-yellow-500/10 text-yellow-400 ring-yellow-500/20'
                }`}
              >
                <span className="font-semibold">
                  {alert.level === 'critical' ? '🔴 Critical' : '⚠️ Warning'}
                </span>{' '}
                : {alert.message}
              </div>
            ))}
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-1 rounded-lg bg-zinc-900/50 p-1 ring-1 ring-zinc-800">
          {(['overview', 'insights', 'audience'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`rounded-md px-4 py-2 text-sm font-medium transition ${
                activeTab === tab
                  ? 'bg-white text-black'
                  : 'text-zinc-400 hover:text-white'
              }`}
            >
              {{ overview: 'Overview', insights: 'Insights', audience: 'Audience' }[tab]}
            </button>
          ))}
        </div>

        {activeTab === 'overview' && (
          <>
            {/* Overview Stats */}
            {usersData && <OverviewStats data={usersData.overview} anonymousData={anonymousData} />}

            {/* System Health + Database (2 columns) */}
            <div className="grid gap-6 md:grid-cols-2">
              {healthData && <SystemHealth data={healthData.system} />}
              {healthData && metricsData?.growth && (
                <DatabaseStats
                  database={healthData.database}
                  growth={metricsData.growth}
                  dailyEvents={metricsData.daily_events}
                />
              )}
            </div>

            {/* Top Users */}
            {usersData && <TopUsersTable users={usersData.topUsers} />}

            {/* Catalogs Chart + Recent Activity (2 columns) */}
            <div className="grid gap-6 md:grid-cols-2">
              {metricsData && <CatalogsChart catalogs={metricsData.top_catalogs} />}
              {metricsData && <RecentActivity dailyEvents={metricsData.daily_events.slice(0, 7)} />}
            </div>
          </>
        )}

        {activeTab === 'insights' && anonymousData && (
          <>
            {/* Top Streamed Films */}
            <div className="grid gap-6 md:grid-cols-2">
              <div className="rounded-xl bg-zinc-900/50 p-6 ring-1 ring-zinc-800">
                <h2 className="mb-4 text-lg font-semibold">Top Films (streams)</h2>
                {anonymousData.topFilms.length === 0 ? (
                  <p className="text-sm text-zinc-500">Aucune donnée</p>
                ) : (
                  <div className="space-y-2">
                    {anonymousData.topFilms.map((film, i) => {
                      const maxCount = anonymousData.topFilms[0]!.count;
                      return (
                        <div key={film.imdbId} className="flex items-center gap-3">
                          <span className="w-5 text-right text-xs text-zinc-500">{i + 1}</span>
                          <div className="flex-1">
                            <div className="flex justify-between text-sm">
                              <a
                                href={`https://www.imdb.com/title/${film.imdbId}/`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-zinc-300 hover:text-white transition truncate max-w-[200px]"
                                title={film.title ?? film.imdbId}
                              >
                                {film.title ?? film.imdbId}
                              </a>
                              <span className="text-zinc-400">{film.count}</span>
                            </div>
                            <div className="mt-1 h-1.5 rounded-full bg-zinc-800">
                              <div className="h-1.5 rounded-full bg-white/70 transition-all" style={{ width: `${(film.count / maxCount) * 100}%` }} />
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Top Lists */}
              <div className="rounded-xl bg-zinc-900/50 p-6 ring-1 ring-zinc-800">
                <h2 className="mb-4 text-lg font-semibold">Top Listes (catalog views)</h2>
                {anonymousData.topLists.length === 0 ? (
                  <p className="text-sm text-zinc-500">Aucune donnée</p>
                ) : (
                  <div className="space-y-2">
                    {anonymousData.topLists.map((list, i) => {
                      const maxCount = anonymousData.topLists[0]!.count;
                      return (
                        <div key={list.listId} className="flex items-center gap-3">
                          <span className="w-5 text-right text-xs text-zinc-500">{i + 1}</span>
                          <div className="flex-1">
                            <div className="flex justify-between text-sm">
                              <span className="text-zinc-300 truncate max-w-[200px]" title={list.listName ?? list.listId}>
                                {list.listName ?? list.listId}
                              </span>
                              <span className="text-zinc-400">{list.count}</span>
                            </div>
                            <div className="mt-1 h-1.5 rounded-full bg-zinc-800">
                              <div className="h-1.5 rounded-full bg-white/70 transition-all" style={{ width: `${(list.count / maxCount) * 100}%` }} />
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Actions + Catalog Breakdown */}
            <div className="grid gap-6 md:grid-cols-2">
              {/* User Actions */}
              <div className="rounded-xl bg-zinc-900/50 p-6 ring-1 ring-zinc-800">
                <h2 className="mb-4 text-lg font-semibold">Actions utilisateur</h2>
                {anonymousData.actions.length === 0 ? (
                  <p className="text-sm text-zinc-500">Aucune donnée</p>
                ) : (
                  <div className="space-y-3">
                    {anonymousData.actions.map((a) => {
                      const maxCount = Math.max(...anonymousData.actions.map((x) => x.count), 1);
                      const label = a.action.replace('action_', '');
                      return (
                        <div key={a.action}>
                          <div className="mb-1 flex justify-between text-sm">
                            <span className="text-zinc-400 capitalize">{label}</span>
                            <span className="text-white">{a.count}</span>
                          </div>
                          <div className="h-2 rounded-full bg-zinc-800">
                            <div className="h-2 rounded-full bg-white/70 transition-all" style={{ width: `${(a.count / maxCount) * 100}%` }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Catalog Breakdown by tier */}
              <div className="rounded-xl bg-zinc-900/50 p-6 ring-1 ring-zinc-800">
                <h2 className="mb-4 text-lg font-semibold">Catalogs par tier</h2>
                {anonymousData.catalogBreakdown.length === 0 ? (
                  <p className="text-sm text-zinc-500">Aucune donnée</p>
                ) : (
                  <div className="space-y-2">
                    {anonymousData.catalogBreakdown.map((c) => {
                      const maxCount = Math.max(...anonymousData.catalogBreakdown.map((x) => x.count), 1);
                      const name = c.catalog.replace('catalog_', '');
                      return (
                        <div key={`${c.catalog}-${c.tier}`}>
                          <div className="mb-1 flex justify-between text-sm">
                            <span className="text-zinc-400">
                              <span className="capitalize">{name}</span>
                              <span className={`ml-2 text-xs px-1.5 py-0.5 rounded ${c.tier === 'auth' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-zinc-700/50 text-zinc-400'}`}>
                                {c.tier}
                              </span>
                            </span>
                            <span className="text-white">{c.count}</span>
                          </div>
                          <div className="h-1.5 rounded-full bg-zinc-800">
                            <div className="h-1.5 rounded-full bg-white/50 transition-all" style={{ width: `${(c.count / maxCount) * 100}%` }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Top Actioned Films */}
            {anonymousData.topActionedFilms.length > 0 && (
              <div className="rounded-xl bg-zinc-900/50 p-6 ring-1 ring-zinc-800">
                <h2 className="mb-4 text-lg font-semibold">Top films (actions)</h2>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {anonymousData.topActionedFilms.map((f, i) => (
                    <div key={`${f.filmId}-${f.action}-${i}`} className="flex items-center justify-between rounded-lg bg-zinc-800/50 px-3 py-2">
                      <div className="text-sm">
                        <span className="text-zinc-300 truncate max-w-[180px]" title={f.title ?? f.filmId}>{f.title ?? f.filmId}</span>
                        <span className={`ml-2 text-xs px-1.5 py-0.5 rounded ${
                          f.action.includes('watched') ? 'bg-blue-500/20 text-blue-400' :
                          f.action.includes('liked') ? 'bg-red-500/20 text-red-400' :
                          f.action.includes('watchlist') ? 'bg-yellow-500/20 text-yellow-400' :
                          'bg-zinc-700/50 text-zinc-400'
                        }`}>
                          {f.action.replace('action_', '')}
                        </span>
                      </div>
                      <span className="text-sm text-zinc-400">{f.count}x</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {activeTab === 'audience' && anonymousData && (
          <>
            {/* Unique Users Breakdown */}
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="rounded-xl bg-zinc-900/50 p-4 ring-1 ring-zinc-800">
                <p className="text-sm text-zinc-400">Authenticated Users</p>
                <p className="mt-1 text-2xl font-semibold text-white">{anonymousData.uniqueUsers.authenticated}</p>
              </div>
              <div className="rounded-xl bg-zinc-900/50 p-4 ring-1 ring-zinc-800">
                <p className="text-sm text-zinc-400">Anonymous Users</p>
                <p className="mt-1 text-2xl font-semibold text-white">{anonymousData.uniqueUsers.anonymous}</p>
              </div>
              <div className="rounded-xl bg-zinc-900/50 p-4 ring-1 ring-zinc-800">
                <p className="text-sm text-zinc-400">Total Unique</p>
                <p className="mt-1 text-2xl font-semibold text-white">{anonymousData.uniqueUsers.total}</p>
              </div>
            </div>

            {/* Peak Hours + Funnel (2 columns) */}
            <div className="grid gap-6 md:grid-cols-2">
              <PeakHoursChart data={anonymousData.peakHours} />

              <div className="rounded-xl bg-zinc-900/50 p-6 ring-1 ring-zinc-800">
                <h2 className="mb-4 text-lg font-semibold">Funnel d&apos;usage</h2>
                <div className="space-y-3">
                  {[
                    { label: 'Manifest Views', value: anonymousData.funnel.manifestViews },
                    { label: 'Catalog Fetches', value: anonymousData.funnel.catalogFetches },
                    { label: 'Authenticated', value: anonymousData.funnel.authenticated },
                  ].map((step) => {
                    const maxVal = Math.max(
                      anonymousData.funnel.manifestViews,
                      anonymousData.funnel.catalogFetches,
                      anonymousData.funnel.authenticated,
                      1
                    );
                    const barPct = Math.min(Math.round((step.value / maxVal) * 100), 100);
                    return (
                      <div key={step.label}>
                        <div className="mb-1 flex justify-between text-sm">
                          <span className="text-zinc-400">{step.label}</span>
                          <span className="text-white">{step.value}</span>
                        </div>
                        <div className="h-2 rounded-full bg-zinc-800">
                          <div
                            className="h-2 rounded-full bg-white transition-all"
                            style={{ width: `${barPct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Survival */}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-xl bg-zinc-900/50 p-4 ring-1 ring-zinc-800">
                <p className="text-sm text-zinc-400">Durée moy. d&apos;utilisation</p>
                <p className="mt-1 text-2xl font-semibold text-white">{anonymousData.survival.avgDays} jours</p>
                <p className="mt-0.5 text-xs text-zinc-500">Entre 1er et dernier event (auth uniquement)</p>
              </div>
              <div className="rounded-xl bg-zinc-900/50 p-4 ring-1 ring-zinc-800">
                <p className="text-sm text-zinc-400">Durée médiane d&apos;utilisation</p>
                <p className="mt-1 text-2xl font-semibold text-white">{anonymousData.survival.medianDays} jours</p>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
