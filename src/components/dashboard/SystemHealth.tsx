interface SystemHealthProps {
  data: {
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
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  if (days > 0) return `${days}j ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function SystemHealth({ data }: SystemHealthProps) {
  const memoryPercentage = Math.min(data.memory.percentage, 100);
  const memoryColor = data.memory.warning ? 'bg-red-500' : 'bg-green-500';

  return (
    <div className="rounded-xl bg-zinc-900/50 p-6 ring-1 ring-zinc-800">
      <h2 className="mb-4 text-lg font-semibold">System Health</h2>

      <div className="space-y-4">
        {/* Uptime */}
        <div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-zinc-400">Uptime</span>
            <span className="font-mono text-white">{formatUptime(data.uptime)}</span>
          </div>
        </div>

        {/* Memory */}
        <div>
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="text-zinc-400">Memory (RAM)</span>
            <span className="font-mono text-white">
              {data.memory.used} MB / {data.memory.total} MB
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-zinc-800">
            <div
              className={`h-full transition-all ${memoryColor}`}
              style={{ width: `${memoryPercentage}%` }}
            />
          </div>
          <div className="mt-1 text-right text-xs text-zinc-500">
            {data.memory.percentage.toFixed(1)}%
          </div>
        </div>

        {/* CPU */}
        <div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-zinc-400">CPU Usage</span>
            <span className="font-mono text-white">{data.cpu.percentage.toFixed(1)}%</span>
          </div>
        </div>
      </div>
    </div>
  );
}
