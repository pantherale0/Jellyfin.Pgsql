import { useState, useEffect } from 'preact/hooks';
import { ConfirmButton, Card, InfoRow, StatusChip } from './ui';

interface PluginShellProps {
    name: string;
    description?: string;
    status?: string;
    session: { server: string };
    onSave?: () => Promise<void>;
    onReset?: () => Promise<void>;
    children: any;
    modified?: boolean;
}

export function PluginPageShell({ name, description, status, session, onSave, onReset, children, modified }: PluginShellProps) {
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState('');
    const [confirmNav, setConfirmNav] = useState(false);
    const [previousKey, setPreviousKey] = useState('');

    useEffect(() => {
        const block = (event: KeyboardEvent) => {
            if (modified && event.key === 'Escape') { setConfirmNav(true); }
        };
        const unload = (event: BeforeUnloadEvent) => {
            if (modified) { event.preventDefault(); event.returnValue = ''; }
        };
        window.addEventListener('keydown', block);
        window.addEventListener('beforeunload', unload);
        return () => { window.removeEventListener('keydown', block); window.removeEventListener('beforeunload', unload); };
    }, [modified]);

    const doSave = async () => {
        if (!onSave) return;
        setSaving(true); setMessage('');
        try { await onSave(); setMessage('Saved.'); setTimeout(() => setMessage(''), 3000); }
        catch (e) { setMessage(e instanceof Error ? e.message : 'Save failed.'); }
        setSaving(false);
    };

    return <div class="admin-plugin-config">
        <div class="admin-plugin-toolbar">
            <div>
                <h1>{name}</h1>
                <div class="ad-flex">
                    {description && <span class="admin-plugin-note">{description}</span>}
                    <StatusChip tone={status === 'Active' ? 'green' : status === 'Malfunctioned' ? 'red' : 'muted'}>{status === 'Active' ? 'Enabled' : status || 'Unknown'}</StatusChip>
                </div>
            </div>
            <div class="ad-flex">
                {message && <span role="status" class={`ad-note${message.includes('fail') ? ' ad-error' : ''}`}>{message}</span>}
                {onSave && <ConfirmButton label={saving ? 'Saving…' : 'Save settings'} onConfirm={doSave} />}
                <a class="ad-btn" href={`${session.server}/web/index.html#!/dashboard`} target="_blank" rel="noopener">Classic dashboard</a>
            </div>
        </div>
        <div class="admin-plugin-body">
            {confirmNav && <div class="ad-unsaved-bar"><p>You have unsaved changes.</p><ConfirmButton label="Discard and leave" tone="danger" onConfirm={() => { setConfirmNav(false); window.dispatchEvent(new Event('unsaved-discard')); }} /><button class="ad-btn" onClick={() => setConfirmNav(false)}>Stay</button></div>}
            {children}
        </div>
    </div>;
}