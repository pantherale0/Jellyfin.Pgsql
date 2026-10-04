import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { AdminApi } from './admin-api';

export function LiveLogViewer({ api, logName, onNameChange }: {
    api: AdminApi; logName: string; onNameChange: (name: string) => void;
}) {
    const [logs, setLogs] = useState<Array<{ Name?: string; Size?: number }>>([]);
    const [lines, setLines] = useState<Array<{ text: string; severity: string; ts: string; rest: string }>>([]);
    const [paused, setPaused] = useState(false);
    const [search, setSearch] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const [totalBytes, setTotalBytes] = useState(0);
    const pollTimer = useRef<number>();
    const previousLength = useRef(0);
    const containerRef = useRef<HTMLDivElement>(null);
    const [autoScroll, setAutoScroll] = useState(true);

    // Load log file list
    useEffect(() => {
        api.getLogs().then(rows => {
            setLogs(rows);
            if (!logName && rows[0]?.Name) onNameChange(rows[0].Name);
        }).catch(() => undefined);
    }, [api]);

    // Poll the active log file
    const loadLog = useCallback(async () => {
        if (!logName || paused) return;
        setLoading(true); setError('');
        try {
            const text = await api.getLogText(logName);
            const bytes = new Blob([text]).size;
            setTotalBytes(bytes);
            const allLines = text.split('\n');
            const isNew = previousLength.current === 0 || !lines.length;
            const newChunk = isNew ? allLines : allLines.slice(previousLength.current ? lines.length : 0);
            previousLength.current = allLines.length;

            if (newChunk.length === 0 && isNew) {
                setLines([]);
                setLoading(false);
                return;
            }

            const parsed = (isNew ? allLines : newChunk).map(parseLine);
            setLines(prev => isNew ? parsed : [...prev, ...parsed].slice(-2000));
            if (autoScroll && containerRef.current) {
                containerRef.current.scrollTop = containerRef.current.scrollHeight;
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not load log.');
        }
        setLoading(false);
    }, [api, logName, paused, autoScroll, lines.length]);

    useEffect(() => {
        previousLength.current = 0;
        setLines([]);
        setTotalBytes(0);
        if (!logName) return;
        void loadLog();
        pollTimer.current = window.setInterval(loadLog, 3000);
        return () => window.clearInterval(pollTimer.current);
    }, [logName, paused]);

    const filtered = search.trim()
        ? lines.filter(l => l.text.toLowerCase().includes(search.toLowerCase()))
        : lines;
    const visible = filtered.slice(-500);

    return <div class="llv">
        <div class="ad-toolbar">
            <select class="ad-select" value={logName} onChange={e => onNameChange(e.currentTarget.value)} aria-label="Choose log file">
                {logs.map(l => <option key={l.Name} value={l.Name}>{l.Name} · {fmtSize(l.Size || 0)}</option>)}
            </select>
            <button class="ad-btn" onClick={() => { previousLength.current = 0; setLines([]); void loadLog(); }}>
                {loading ? 'Loading…' : '⟳ Reload'}
            </button>
            <button class={`ad-btn${paused ? ' danger' : ''}`} onClick={() => setPaused(v => !v)}>
                {paused ? '▶ Resume' : '⏸ Pause'}
            </button>
            <span class="llv-status">
                {totalBytes > 0 && <span class="ad-note">{fmtSize(totalBytes)} · {lines.length} lines</span>}
                {paused && <span class="ad-st amber">Paused</span>}
            </span>
        </div>
        <div class="ad-toolbar">
            <input class="ad-search" value={search} onInput={e => setSearch(e.currentTarget.value)} placeholder="Filter log lines…" aria-label="Filter log lines" />
            <span class="ad-note">{filtered.length !== lines.length ? `${filtered.length} of ` : ''}{lines.length} lines{visible.length < filtered.length ? ` (showing latest 500)` : ''}</span>
            <button class={`ad-btn${autoScroll ? ' active' : ''}`} onClick={() => setAutoScroll(v => !v)}>{autoScroll ? 'Auto-scroll on' : 'Auto-scroll off'}</button>
        </div>
        {error && <p class="ad-error" role="alert">{error}</p>}
        {lines.length === 0 && !error && <p class="ad-empty muted">Waiting for log content…</p>}
        <div ref={containerRef} class="llv-log" onScroll={() => {
            if (!containerRef.current) return;
            const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
            setAutoScroll(scrollHeight - scrollTop - clientHeight < 60);
        }}>
            {visible.map((line, i) => <div key={i} class={`llv-line llv-${line.severity}`}>
                {line.ts && <span class="llv-ts">{line.ts}</span>}
                <span class="llv-sev">{line.severity}</span>
                <span class="llv-msg">{highlight(search, line.rest || line.text)}</span>
            </div>)}
        </div>
    </div>;
}

function parseLine(text: string): { text: string; severity: string; ts: string; rest: string } {
    const severity = text.match(/\b(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\b/)?.[1] || 'INFO';
    const tsMatch = text.match(/^(\d{4}[-\d]+\s[\d:,.]+)/);
    const ts = tsMatch?.[1] || '';
    const rest = tsMatch ? text.slice(tsMatch[0].length).trim() : text;
    return { text, severity, ts, rest };
}

function highlight(query: string, text: string): any {
    if (!query.trim()) return text;
    const parts = text.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));
    return parts.map((part, i) => part.toLowerCase() === query.toLowerCase() ? <mark key={i}>{part}</mark> : part);
}

function fmtSize(size: number): string {
    return size >= 1024 ** 2 ? `${(size / 1024 ** 2).toFixed(1)} MB` : `${Math.round(size / 1024)} KB`;
}