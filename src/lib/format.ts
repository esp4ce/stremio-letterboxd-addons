export function formatRange(days: number): string {
  if (days === 0) return 'all time';
  if (days === 1) return '24h';
  return `${days}d`;
}
