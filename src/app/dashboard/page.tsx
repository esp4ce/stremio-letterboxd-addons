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

export default function Dashboard() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [healthData, setHealthData] = useState<DetailedHealthData | null>(null);
  const [usersData, setUsersData] = useState<TopUsersData | null>(null);
  const [metricsData, setMetricsData] = useState<MetricsSummaryData | null>(null);

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
      const [healthRes, usersRes, metricsRes] = await Promise.all([
        fetchWithAuth(`${backendUrl}/health/detailed`),
        fetchWithAuth(`${backendUrl}/metrics/users?days=30&limit=10`),
        fetchWithAuth(`${backendUrl}/metrics/summary?days=30`),
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

      setHealthData(health);
      setUsersData(users);
      setMetricsData(metrics);
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

        {/* Overview Stats */}
        {usersData && <OverviewStats data={usersData.overview} />}

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
      </div>
    </div>
  );
}
