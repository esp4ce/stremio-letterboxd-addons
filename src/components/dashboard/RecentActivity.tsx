interface RecentActivityProps {
  dailyEvents: Array<{ date: string; count: number }>;
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (date.toDateString() === today.toDateString()) {
    return 'Today';
  }
  if (date.toDateString() === yesterday.toDateString()) {
    return 'Yesterday';
  }

  return date.toLocaleDateString('en-US', { day: '2-digit', month: 'short', weekday: 'short' });
}

export function RecentActivity({ dailyEvents }: RecentActivityProps) {
  return (
    <div className="rounded-xl bg-zinc-900/50 p-6 ring-1 ring-zinc-800">
      <h2 className="mb-4 text-lg font-semibold">Recent Activity</h2>

      <div className="space-y-3">
        {dailyEvents.map((day) => (
          <div key={day.date} className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="h-2 w-2 rounded-full bg-white" />
              <span className="text-sm text-zinc-300">{formatDate(day.date)}</span>
            </div>
            <span className="font-mono text-sm text-white">
              {day.count.toLocaleString()} events
            </span>
          </div>
        ))}
      </div>

      {dailyEvents.length === 0 && (
        <div className="py-8 text-center text-sm text-zinc-500">No recent activity</div>
      )}
    </div>
  );
}
