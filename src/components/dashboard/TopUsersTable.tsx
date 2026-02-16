interface TopUsersTableProps {
  users: Array<{
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

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();

  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 30) return `${days}d ago`;

  return date.toLocaleDateString('en-US', { day: '2-digit', month: 'short' });
}

export function TopUsersTable({ users }: TopUsersTableProps) {
  return (
    <div className="rounded-xl bg-zinc-900/50 p-6 ring-1 ring-zinc-800">
      <h2 className="mb-4 text-lg font-semibold">Top Users (30d)</h2>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-left text-zinc-400">
              <th className="pb-3 font-medium">User</th>
              <th className="pb-3 font-medium">Events</th>
              <th className="hidden pb-3 font-medium sm:table-cell">Catalogs</th>
              <th className="hidden pb-3 font-medium sm:table-cell">Actions</th>
              <th className="pb-3 font-medium">Last Activity</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {users.map((user) => (
              <tr key={user.userId} className="text-white">
                <td className="py-3">
                  <div>
                    <div className="font-medium">
                      {user.displayName || user.username || 'Anonymous User'}
                    </div>
                    {user.displayName && user.username && (
                      <div className="text-xs text-zinc-500">@{user.username}</div>
                    )}
                  </div>
                </td>
                <td className="py-3">
                  <span className="font-mono">{user.totalEvents}</span>
                </td>
                <td className="hidden py-3 sm:table-cell">
                  <span className="font-mono text-zinc-300">{user.breakdown.catalog_views}</span>
                </td>
                <td className="hidden py-3 sm:table-cell">
                  <span className="font-mono text-zinc-300">{user.breakdown.actions}</span>
                </td>
                <td className="py-3 text-zinc-400">{formatDate(user.lastActivity)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
