"use client";

import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';

interface PeakHoursChartProps {
  data: Array<{ hour: number; count: number }>;
}

export function PeakHoursChart({ data }: PeakHoursChartProps) {
  const maxCount = Math.max(...data.map((d) => d.count), 1);

  const chartData = data.map((d) => ({
    name: `${d.hour.toString().padStart(2, '0')}h`,
    events: d.count,
    intensity: d.count / maxCount,
  }));

  return (
    <div className="rounded-xl bg-zinc-900/50 p-6 ring-1 ring-zinc-800">
      <h2 className="mb-4 text-lg font-semibold">Peak Hours (UTC)</h2>

      <ResponsiveContainer width="100%" height={250}>
        <BarChart data={chartData}>
          <XAxis
            dataKey="name"
            stroke="#71717a"
            tick={{ fill: '#a1a1aa', fontSize: 10 }}
            interval={2}
          />
          <YAxis stroke="#71717a" tick={{ fill: '#a1a1aa', fontSize: 11 }} width={40} />
          <Tooltip
            contentStyle={{
              backgroundColor: '#18181b',
              border: '1px solid #3f3f46',
              borderRadius: '0.5rem',
              color: '#fafafa',
              fontSize: '12px',
            }}
            cursor={{ fill: '#27272a' }}
          />
          <Bar dataKey="events" radius={[2, 2, 0, 0]}>
            {chartData.map((entry, index) => (
              <Cell
                key={index}
                fill={`rgba(255, 255, 255, ${0.2 + entry.intensity * 0.8})`}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
