"use client";

import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

interface DatabaseStatsProps {
  database: {
    sizeBytes: number;
    sizeMB: string;
    totalEvents: number;
    oldestEvent: string | null;
    newestEvent: string | null;
  };
  growth: {
    eventsLast7Days: number;
    eventsLast30Days: number;
    newUsersLast7Days: number;
    avgEventsPerDay: number;
    projectedDbSizeIn30Days: string;
  };
  dailyEvents: Array<{ date: string; count: number }>;
}

export function DatabaseStats({ database, growth, dailyEvents }: DatabaseStatsProps) {
  // Reverse to show oldest to newest
  const chartData = [...dailyEvents].reverse();

  return (
    <div className="rounded-xl bg-zinc-900/50 p-6 ring-1 ring-zinc-800">
      <h2 className="mb-4 text-lg font-semibold">Database</h2>

      <div className="space-y-4">
        {/* Current size */}
        <div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-zinc-400">Current size</span>
            <span className="font-mono text-white">{database.sizeMB} MB</span>
          </div>
        </div>

        {/* Projected size */}
        <div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-zinc-400">Projected (30d)</span>
            <span className="font-mono text-white">{growth.projectedDbSizeIn30Days} MB</span>
          </div>
        </div>

        {/* Total events */}
        <div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-zinc-400">Total events</span>
            <span className="font-mono text-white">{database.totalEvents.toLocaleString()}</span>
          </div>
        </div>

        {/* Avg events per day */}
        <div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-zinc-400">Avg events/day</span>
            <span className="font-mono text-white">{growth.avgEventsPerDay.toFixed(1)}</span>
          </div>
        </div>

        {/* Chart */}
        <div className="pt-2">
          <p className="mb-2 text-xs text-zinc-500">Events per day (last 30 days)</p>
          <ResponsiveContainer width="100%" height={120}>
            <LineChart data={chartData}>
              <XAxis
                dataKey="date"
                stroke="#71717a"
                tick={{ fill: '#a1a1aa', fontSize: 10 }}
                tickFormatter={(value: string) => {
                  const date = new Date(value);
                  return `${date.getDate()}/${date.getMonth() + 1}`;
                }}
              />
              <YAxis stroke="#71717a" tick={{ fill: '#a1a1aa', fontSize: 10 }} width={30} />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#18181b',
                  border: '1px solid #3f3f46',
                  borderRadius: '0.5rem',
                  color: '#fafafa',
                  fontSize: '12px',
                }}
                labelFormatter={(value: string) => {
                  const date = new Date(value);
                  return `${date.getDate()}/${date.getMonth() + 1}/${date.getFullYear()}`;
                }}
              />
              <Line
                type="monotone"
                dataKey="count"
                stroke="#ffffff"
                strokeWidth={2}
                dot={{ fill: '#ffffff', r: 2 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
