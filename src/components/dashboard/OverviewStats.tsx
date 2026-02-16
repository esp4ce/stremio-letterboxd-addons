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
}

export function OverviewStats({ data }: OverviewStatsProps) {
  const stats = [
    { label: 'Total Users', value: data.totalUsers, icon: '👥' },
    { label: 'Active (7d)', value: data.activeUsers7d, icon: '🟢' },
    { label: 'Active (30d)', value: data.activeUsers30d, icon: '🔵' },
    { label: 'Total Events', value: data.totalEvents.toLocaleString(), icon: '📊' },
    { label: 'Avg Events/User', value: data.avgEventsPerUser.toFixed(1), icon: '📈' },
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
            </div>
            <div className="text-3xl">{stat.icon}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
