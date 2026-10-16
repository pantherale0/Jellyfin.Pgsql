import { useState, useEffect } from 'preact/hooks';
import { classicWebAvailable } from '../build-features';
import { ConfirmButton, StatusChip } from './ui';
import { registerUnsavedGuard } from './admin-state';
import { t } from '../i18n';

const classicWebLinksAvailable = classicWebAvailable(import.meta.env.VITE_CLASSIC_WEB_AVAILABLE);

interface PluginShellProps {
    name: string;
    description?: string;
    status?: string;
    session: { server: string };
    onSave?: () => Promise<void>;
    onDiscard?: () => void;
    children: any;
    modified?: boolean;
    loaded?: boolean;
    loadError?: string;
}

export function PluginPageShell({ name, description, status, session, onSave, onDiscard, children, modified, loaded = true, loadError }: PluginShellProps) {
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState('');
    const [confirmNav, setConfirmNav] = useState(false);

    useEffect(() => modified ? registerUnsavedGuard(() => true) : undefined, [modified]);

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
        try { await onSave(); setMessage(t('Saved.')); setTimeout(() => setMessage(''), 3000); }
        catch (e) { setMessage(e instanceof Error ? e.message : t('Save failed.')); }
        setSaving(false);
    };

    return <div class="admin-plugin-config">
        <div class="admin-plugin-toolbar">
            <div>
                <h1>{name}</h1>
                <div class="ad-flex">
                    {description && <span class="admin-plugin-note">{description}</span>}
                    <StatusChip tone={status === 'Active' ? 'green' : status === 'Malfunctioned' ? 'red' : 'muted'}>{status === 'Active' ? t('Enabled') : status || t('Unknown')}</StatusChip>
                </div>
            </div>
            <div class="ad-flex">
                {message && <span role="status" class={`ad-note${message.includes('fail') ? ' ad-error' : ''}`}>{message}</span>}
                {onSave && loaded && <ConfirmButton label={saving ? t('Saving…') : t('Save settings')} onConfirm={doSave} />}
                {classicWebLinksAvailable && <a class="ad-btn" href={`${session.server}/web/index.html#!/dashboard`} target="_blank" rel="noopener">{t('Classic dashboard')}</a>}
            </div>
        </div>
        <div class="admin-plugin-body">
            {confirmNav && <div class="ad-unsaved-bar"><p>{t('You have unsaved changes.')}</p><ConfirmButton label={t('Discard changes')} tone="danger" onConfirm={() => { setConfirmNav(false); onDiscard?.(); }} /><button class="ad-btn" onClick={() => setConfirmNav(false)}>{t('Stay')}</button></div>}
            {loadError && <p role="alert" class="ad-error">{loadError}</p>}
            {!loaded && !loadError && <p role="status" class="ad-note">{t('Loading configuration…')}</p>}
            {children}
        </div>
    </div>;
}
