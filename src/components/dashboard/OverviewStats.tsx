import { formatRange } from '@/lib/format';

interface OverviewStatsProps {
  data: {
    totalUsers: number;
    activeUsers: number;
    totalEvents: number;
    avgEventsPerUser: number;
    newUsers: number;
  };
  uniqueUsers?: { tier1: number; tier2: number; total: number } | null;
  daysRange: number;
}

export function OverviewStats({ data, uniqueUsers, daysRange }: OverviewStatsProps) {
  const uniqueTotal = uniqueUsers ? uniqueUsers.total : data.totalUsers;
  const uniqueLabel = uniqueUsers ? `${uniqueUsers.tier2} tier 2 + ${uniqueUsers.tier1} tier 1` : '';
  const range = formatRange(daysRange);

  const stats = [
    { label: 'Unique Users', value: uniqueTotal, sublabel: uniqueLabel, icon: '👥' },
    { label: `Active (${range})`, value: data.activeUsers, icon: '🟢' },
    { label: `Total Events (${range})`, value: data.totalEvents.toLocaleString(), icon: '📊' },
    { label: `New Users (${range})`, value: data.newUsers, icon: '✨' },
  ];

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-2">
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
