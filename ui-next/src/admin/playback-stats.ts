export const STAT_DIMENSIONS: Array<[string, string]> = [ [ 'Client', 'Client' ], [ 'Device', 'Device' ], [ 'Method', 'Method' ], [ 'Genre', 'Genre' ], [ 'MediaType', 'Media type' ] ];

/** 7×24 play counts (Sunday first) plus the busiest cell, for the day/hour heat map. */
export function hourlyGrid(rows: Array<{ DayOfWeek?: number; Hour?: number; PlayCount?: number }>): { grid: number[][]; max: number } {
    const grid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
    rows.forEach(row => {
        const day = row.DayOfWeek ?? -1, hour = row.Hour ?? -1;
        if (day >= 0 && day < 7 && hour >= 0 && hour < 24) grid[day][hour] += row.PlayCount || 0;
    });
    return { grid, max: Math.max(0, ...grid.flat()) };
}

/** Per-user totals across media types, named from the user list and sorted by plays. */
export function userTotals(rows: Array<{ UserId?: string; PlayCount?: number; TotalTicks?: number }>, users: Array<{ Id: string; Name: string }>): Array<{ id: string; name: string; plays: number; ticks: number }> {
    const compact = (id = '') => id.replace(/-/g, '').toLowerCase();
    const totals = new Map<string, { id: string; name: string; plays: number; ticks: number }>();
    rows.forEach(row => {
        const id = compact(row.UserId);
        const current = totals.get(id) || { id, name: users.find(user => compact(user.Id) === id)?.Name || 'Deleted user', plays: 0, ticks: 0 };
        current.plays += row.PlayCount || 0;
        current.ticks += row.TotalTicks || 0;
        totals.set(id, current);
    });
    return [ ...totals.values() ].sort((a, b) => b.plays - a.plays || a.name.localeCompare(b.name));
}

export function formatPlayed(ticks?: number): string {
    if (!ticks) return '0h';
    const hours = ticks / 36_000_000_000;
    return hours < 1 ? `${Math.round(hours * 60)}m` : `${hours.toFixed(hours < 10 ? 1 : 0)}h`;
}
