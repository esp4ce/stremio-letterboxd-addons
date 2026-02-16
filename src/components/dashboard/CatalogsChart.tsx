"use client";

import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

interface CatalogsChartProps {
  catalogs: Array<{ catalog: string; count: number }>;
}

function formatCatalogName(catalog: string): string {
  const names: Record<string, string> = {
    catalog_watchlist: 'Watchlist',
    catalog_diary: 'Diary',
    catalog_friends: 'Friends',
    catalog_list: 'Lists',
    catalog_popular: 'Popular',
    catalog_top250: 'Top 250',
  };
  return names[catalog] || catalog.replace('catalog_', '');
}

export function CatalogsChart({ catalogs }: CatalogsChartProps) {
  const chartData = catalogs.map((c) => ({
    name: formatCatalogName(c.catalog),
    views: c.count,
  }));

  return (
    <div className="rounded-xl bg-zinc-900/50 p-6 ring-1 ring-zinc-800">
      <h2 className="mb-4 text-lg font-semibold">Popular Catalogs</h2>

      <ResponsiveContainer width="100%" height={250}>
        <BarChart data={chartData}>
          <XAxis
            dataKey="name"
            stroke="#71717a"
            tick={{ fill: '#a1a1aa', fontSize: 11 }}
            angle={-45}
            textAnchor="end"
            height={80}
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
          <Bar dataKey="views" fill="#ffffff" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
