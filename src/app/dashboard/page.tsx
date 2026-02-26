"use client";

import { useEffect, useState, useCallback } from 'react';
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
    activeUsers: number;
    totalEvents: number;
    avgEventsPerUser: number;
    newUsers: number;
  };
  topUsers: Array<{
    userId: string;
    username: string | null;
    displayName: string | null;
    tier: number;
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
  time_events: Array<{ date: string; count: number }>;
  granularity: 'hour' | 'day';
  daily_active_users: Array<{ date: string; count: number }>;
  top_catalogs: Array<{ catalog: string; count: number }>;
  growth?: {
    avgEventsPerDay: number;
    newUsersInPeriod: number;
    projectedDbSizeIn30Days: string;
  };
  database?: {
    totalEvents: number;
    oldestEvent: string | null;
    sizeBytes: number;
    sizeMB: string;
  };
}

interface AudienceData {
  uniqueUsers: { tier1: number; tier2: number; total: number };
  peakHours: Array<{ hour: number; count: number }>;
  topFilms: Array<{ imdbId: string; title?: string; count: number }>;
  topLists: Array<{ listId: string; listName?: string; count: number }>;
  actions: Array<{ action: string; count: number }>;
  topActionedFilms: Array<{ filmId: string; imdbId?: string; title?: string; action: string; count: number }>;
  catalogBreakdown: Array<{ catalog: string; tier: string; count: number }>;
}

type DashboardTab = 'overview' | 'insights' | 'audience';

const TIME_RANGES = [
  { label: '24h', days: 1 },
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: 'All', days: 0 },
] as const;

export default function Dashboard() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [healthData, setHealthData] = useState<DetailedHealthData | null>(null);
  const [usersData, setUsersData] = useState<TopUsersData | null>(null);
  const [metricsData, setMetricsData] = useState<MetricsSummaryData | null>(null);
  const [audienceData, setAudienceData] = useState<AudienceData | null>(null);
  const [activeTab, setActiveTab] = useState<DashboardTab>('overview');
  const [daysRange, setDaysRange] = useState<number>(30);

  const backendUrl = process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:3001';

  const fetchDashboardData = useCallback(async () => {
    try {
      const [healthRes, usersRes, metricsRes, anonRes] = await Promise.all([
        fetchWithAuth(`${backendUrl}/health/detailed`),
        fetchWithAuth(`${backendUrl}/metrics/users?days=${daysRange}&limit=10`),
        fetchWithAuth(`${backendUrl}/metrics/summary?days=${daysRange}`),
        fetchWithAuth(`${backendUrl}/metrics/anonymous?days=${daysRange}`),
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
      const anonymous = anonRes.ok ? (await anonRes.json()) as AudienceData : null;

      setHealthData(health);
      setUsersData(users);
      setMetricsData(metrics);
      setAudienceData(anonymous);
      setError('');
      setLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dashboard');
      setLoading(false);
    }
  }, [backendUrl, daysRange, router]);

  useEffect(() => {
    const token = getToken();
    if (!token || isTokenExpired(token)) {
      router.push('/dashboard/login');
      return;
    }

    fetchDashboardData();

    const interval = setInterval(() => {
      fetchDashboardData();
    }, 10000);

    return () => clearInterval(interval);
  }, [router, fetchDashboardData]);

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
          <div className="flex items-center gap-3">
            {/* Time range filter */}
            <div className="flex gap-1 rounded-lg bg-zinc-900/50 p-1 ring-1 ring-zinc-800">
              {TIME_RANGES.map((range) => (
                <button
                  key={range.days}
                  onClick={() => setDaysRange(range.days)}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
                    daysRange === range.days
                      ? 'bg-white text-black'
                      : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  {range.label}
                </button>
              ))}
            </div>
            <button
              onClick={handleLogout}
              className="rounded-lg bg-zinc-900/50 px-4 py-2 text-sm text-zinc-300 ring-1 ring-zinc-800 transition hover:bg-zinc-800/50"
            >
              Log Out
            </button>
          </div>
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
            {usersData && <OverviewStats data={usersData.overview} uniqueUsers={audienceData?.uniqueUsers} daysRange={daysRange} />}

            <div className="grid gap-6 md:grid-cols-2">
              {healthData && <SystemHealth data={healthData.system} />}
              {healthData && metricsData?.growth && (
                <DatabaseStats
                  database={healthData.database}
                  growth={metricsData.growth}
                  timeEvents={metricsData.time_events}
                  granularity={metricsData.granularity}
                  daysRange={daysRange}
                />
              )}
            </div>

            {usersData && <TopUsersTable users={usersData.topUsers} daysRange={daysRange} />}

            <div className="grid gap-6 md:grid-cols-2">
              {metricsData && <CatalogsChart catalogs={metricsData.top_catalogs} daysRange={daysRange} />}
              {metricsData && <RecentActivity timeEvents={metricsData.time_events} granularity={metricsData.granularity} daysRange={daysRange} />}
            </div>
          </>
        )}

        {activeTab === 'insights' && audienceData && (
          <>
            {/* Top Streamed Films */}
            <div className="grid gap-6 md:grid-cols-2">
              <div className="rounded-xl bg-zinc-900/50 p-6 ring-1 ring-zinc-800">
                <h2 className="mb-4 text-lg font-semibold">Top Films (streams)</h2>
                {audienceData.topFilms.length === 0 ? (
                  <p className="text-sm text-zinc-500">No data</p>
                ) : (
                  <div className="space-y-2">
                    {audienceData.topFilms.map((film, i) => {
                      const maxCount = audienceData.topFilms[0]!.count;
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
                <h2 className="mb-4 text-lg font-semibold">Top Lists (catalog views)</h2>
                {audienceData.topLists.length === 0 ? (
                  <p className="text-sm text-zinc-500">No data</p>
                ) : (
                  <div className="space-y-2">
                    {audienceData.topLists.map((list, i) => {
                      const maxCount = audienceData.topLists[0]!.count;
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
              <div className="rounded-xl bg-zinc-900/50 p-6 ring-1 ring-zinc-800">
                <h2 className="mb-4 text-lg font-semibold">User Actions</h2>
                {audienceData.actions.length === 0 ? (
                  <p className="text-sm text-zinc-500">No data</p>
                ) : (
                  <div className="space-y-3">
                    {audienceData.actions.map((a) => {
                      const maxCount = Math.max(...audienceData.actions.map((x) => x.count), 1);
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

              <div className="rounded-xl bg-zinc-900/50 p-6 ring-1 ring-zinc-800">
                <h2 className="mb-4 text-lg font-semibold">Catalogs by Tier</h2>
                {audienceData.catalogBreakdown.length === 0 ? (
                  <p className="text-sm text-zinc-500">No data</p>
                ) : (
                  <div className="space-y-2">
                    {audienceData.catalogBreakdown.map((c) => {
                      const maxCount = Math.max(...audienceData.catalogBreakdown.map((x) => x.count), 1);
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
            {audienceData.topActionedFilms.length > 0 && (
              <div className="rounded-xl bg-zinc-900/50 p-6 ring-1 ring-zinc-800">
                <h2 className="mb-4 text-lg font-semibold">Top Films (actions)</h2>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {audienceData.topActionedFilms.map((f, i) => (
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

        {activeTab === 'audience' && audienceData && (
          <>
            {/* Tier cards */}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-xl bg-zinc-900/50 p-4 ring-1 ring-zinc-800">
                <p className="text-sm text-zinc-400">Tier 2 (authenticated)</p>
                <p className="mt-1 text-2xl font-semibold text-white">{audienceData.uniqueUsers.tier2}</p>
              </div>
              <div className="rounded-xl bg-zinc-900/50 p-4 ring-1 ring-zinc-800">
                <p className="text-sm text-zinc-400">Tier 1 (public config)</p>
                <p className="mt-1 text-2xl font-semibold text-white">{audienceData.uniqueUsers.tier1}</p>
              </div>
            </div>

            {/* Peak Hours */}
            <PeakHoursChart data={audienceData.peakHours} />
          </>
        )}
      </div>
    </div>
  );
}
