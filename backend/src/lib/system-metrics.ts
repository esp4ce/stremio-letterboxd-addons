import { getDb } from '../db/index.js';

export interface SystemMetrics {
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
}

export interface DatabaseMetrics {
  sizeBytes: number;
  sizeMB: string;
  totalEvents: number;
  oldestEvent: string | null;
  newestEvent: string | null;
}

export interface Alert {
  level: 'warning' | 'critical';
  message: string;
}

const RAILWAY_MEMORY_MB = 512;
const MEMORY_WARNING_THRESHOLD = 0.8; // 80%

export async function getSystemMetrics(): Promise<SystemMetrics> {
  const uptime = process.uptime();

  // Memory metrics
  const memUsage = process.memoryUsage();
  const usedMB = memUsage.heapUsed / 1024 / 1024;
  const percentage = (usedMB / RAILWAY_MEMORY_MB) * 100;

  // CPU metrics - sample over 1 second
  const startUsage = process.cpuUsage();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const endUsage = process.cpuUsage(startUsage);
  const totalMicros = endUsage.user + endUsage.system;
  const cpuPercentage = (totalMicros / 1000000) * 100;

  return {
    uptime,
    memory: {
      used: parseFloat(usedMB.toFixed(2)),
      total: RAILWAY_MEMORY_MB,
      percentage: parseFloat(percentage.toFixed(2)),
      warning: percentage > MEMORY_WARNING_THRESHOLD * 100,
    },
    cpu: {
      user: endUsage.user,
      system: endUsage.system,
      percentage: parseFloat(cpuPercentage.toFixed(2)),
    },
  };
}

export function getDatabaseMetrics(): DatabaseMetrics {
  const db = getDb();

  // Get database size
  const pageCount = db.pragma('page_count', { simple: true }) as number;
  const pageSize = db.pragma('page_size', { simple: true }) as number;
  const sizeBytes = pageCount * pageSize;
  const sizeMB = (sizeBytes / 1024 / 1024).toFixed(2);

  // Get event counts and dates
  const totalEvents = (
    db.prepare('SELECT COUNT(*) as count FROM events').get() as { count: number }
  ).count;

  const oldestEvent = (
    db
      .prepare('SELECT created_at FROM events ORDER BY created_at ASC LIMIT 1')
      .get() as { created_at: string } | undefined
  )?.created_at ?? null;

  const newestEvent = (
    db
      .prepare('SELECT created_at FROM events ORDER BY created_at DESC LIMIT 1')
      .get() as { created_at: string } | undefined
  )?.created_at ?? null;

  return {
    sizeBytes,
    sizeMB,
    totalEvents,
    oldestEvent,
    newestEvent,
  };
}

export function generateAlerts(
  systemMetrics: SystemMetrics,
  dbMetrics: DatabaseMetrics
): Alert[] {
  const alerts: Alert[] = [];

  if (systemMetrics.memory.warning) {
    alerts.push({
      level: 'warning',
      message: `Memory usage is high (${systemMetrics.memory.percentage.toFixed(1)}% of ${RAILWAY_MEMORY_MB}MB)`,
    });
  }

  if (systemMetrics.memory.percentage > 90) {
    alerts.push({
      level: 'critical',
      message: `Critical memory usage (${systemMetrics.memory.percentage.toFixed(1)}%)`,
    });
  }

  const dbSizeMB = parseFloat(dbMetrics.sizeMB);
  if (dbSizeMB > 500) {
    alerts.push({
      level: 'warning',
      message: `Database size is large (${dbMetrics.sizeMB} MB)`,
    });
  }

  return alerts;
}
