interface AnonymousData {
  uniqueUsers: { authenticated: number; anonymous: number; total: number };
  funnel: { manifestViews: number; catalogFetches: number; authenticated: number };
}

interface OverviewStatsProps {
  data: {
    totalUsers: number;
    activeUsers7d: number;
    activeUsers30d: number;
    totalEvents: number;
    avgEventsPerUser: number;
    newUsersLast7d: number;
    newUsersLast30d: number;
  };
  anonymousData?: AnonymousData | null;
}

export function OverviewStats({ data, anonymousData }: OverviewStatsProps) {
  const uniqueTotal = anonymousData ? anonymousData.uniqueUsers.total : data.totalUsers;
  const uniqueLabel = anonymousData ? `${anonymousData.uniqueUsers.authenticated} auth + ${anonymousData.uniqueUsers.anonymous} anon` : '';

  const stats = [
    { label: 'Unique Users', value: uniqueTotal, sublabel: uniqueLabel, icon: '👥' },
    { label: 'Active (7d)', value: data.activeUsers7d, icon: '🟢' },
    { label: 'Active (30d)', value: data.activeUsers30d, icon: '🔵' },
    { label: 'Total Events', value: data.totalEvents.toLocaleString(), icon: '📊' },
    { label: 'Installs Detected', value: anonymousData?.funnel.manifestViews ?? 0, icon: '📦' },
    { label: 'New Users (7d)', value: data.newUsersLast7d, icon: '✨' },
  ];

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {stats.map((stat) => (
        <div
          key={stat.label}
          className="rounded-xl bg-zinc-900/50 p-4 ring-1 ring-zinc-800 transition hover:ring-zinc-700"
        >
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-zinc-400">{stat.label}</p>
              <p className="mt-1 text-2xl font-semibold text-white">{stat.value}</p>
              {'sublabel' in stat && stat.sublabel && (
                <p className="mt-0.5 text-xs text-zinc-500">{stat.sublabel}</p>
              )}
            </div>
            <div className="text-3xl">{stat.icon}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
