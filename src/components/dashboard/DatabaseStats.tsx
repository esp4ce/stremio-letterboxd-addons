"use client";

import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { formatRange } from '@/lib/format';

interface DatabaseStatsProps {
  database: {
    sizeBytes: number;
    sizeMB: string;
    totalEvents: number;
    oldestEvent: string | null;
    newestEvent: string | null;
  };
  growth: {
    avgEventsPerDay: number;
    newUsersInPeriod: number;
    projectedDbSizeIn30Days: string;
  };
  timeEvents: Array<{ date: string; count: number }>;
  granularity: 'hour' | 'day';
  daysRange: number;
}

export function DatabaseStats({ database, growth, timeEvents, granularity, daysRange }: DatabaseStatsProps) {
  const chartData = [...timeEvents].reverse();

  return (
    <div className="rounded-xl bg-zinc-900/50 p-6 ring-1 ring-zinc-800">
      <h2 className="mb-4 text-lg font-semibold">Database</h2>

      <div className="space-y-4">
        <div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-zinc-400">Current size</span>
            <span className="font-mono text-white">{database.sizeMB} MB</span>
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-zinc-400">Projected (30d)</span>
            <span className="font-mono text-white">{growth.projectedDbSizeIn30Days} MB</span>
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-zinc-400">Total events (all time)</span>
            <span className="font-mono text-white">{database.totalEvents.toLocaleString()}</span>
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-zinc-400">Avg events/day</span>
            <span className="font-mono text-white">{growth.avgEventsPerDay.toFixed(1)}</span>
          </div>
        </div>

        {chartData.length > 1 && (
          <div className="pt-2">
            <p className="mb-2 text-xs text-zinc-500">
              Events per {granularity} ({formatRange(daysRange)})
            </p>
            <ResponsiveContainer width="100%" height={120}>
              <LineChart data={chartData}>
                <XAxis
                  dataKey="date"
                  stroke="#71717a"
                  tick={{ fill: '#a1a1aa', fontSize: 10 }}
                  tickFormatter={(value: string) => {
                    if (granularity === 'hour') {
                      return value.slice(11, 16); // "HH:mm"
                    }
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
                    if (granularity === 'hour') {
                      return value.replace('T', ' ');
                    }
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
        )}
      </div>
    </div>
  );
}
