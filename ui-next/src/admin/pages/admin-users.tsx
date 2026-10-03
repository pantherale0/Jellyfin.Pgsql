import { useCallback, useEffect, useState } from 'preact/hooks';
import type { AdminApi } from '../admin-api';

interface UsersProps { api: AdminApi; session: { server: string; user: { Id: string } } }

export function AdminUsers({ api, session }: UsersProps) {
    const [users, setUsers] = useState<Array<{ Id: string; Name: string; HasPassword?: boolean; LastLoginDate?: string; IsAdministrator?: boolean; IsDisabled?: boolean }>>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const list = await api.getUsers();
            setUsers(list);
            setError('');
        } catch {
            setError('Could not load users.');
        }
        setLoading(false);
    }, [api]);

    useEffect(() => { load(); }, [load]);

    return <div class="admin-page">
        <header class="admin-page-header"><h1>Users</h1></header>
        {error && <div class="home-section-error" role="alert"><p>{error}</p><button class="button secondary" onClick={load}>Retry</button></div>}
        {loading && !users.length && <div class="home-section-status" role="status"><span class="mini-spinner" aria-hidden="true" />Loading users…</div>}
        <table class="admin-table">
            <thead><tr><th>Name</th><th>Access</th><th>Last login</th></tr></thead>
            <tbody>{users.map(u => <tr key={u.Id} class={u.Id === session.user.Id ? 'admin-row-current' : ''}>
                <td><strong>{u.Name}</strong>{u.Id === session.user.Id && <span class="admin-badge">You</span>}</td>
                <td>{u.IsDisabled ? <span class="admin-tag muted">Disabled</span> : u.IsAdministrator ? <span class="admin-tag accent">Administrator</span> : <span class="admin-tag">User</span>}</td>
                <td class="admin-cell-muted">{u.LastLoginDate ? fmtDate(u.LastLoginDate) : '—'}</td>
            </tr>)}</tbody>
        </table>
    </div>;
}

function fmtDate(d: string): string { try { return new Date(d).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return d || '—'; } }