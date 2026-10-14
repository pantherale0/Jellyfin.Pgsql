import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { AdminApi } from './admin-api';
import { appendLogText, parseLogLine, type LogTailState } from './admin-state';

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
    const [copied, setCopied] = useState('');
    const rawText = useRef('');
    const tail = useRef<LogTailState>({ lines: [], length: 0 });
    const generation = useRef(0);
    const containerRef = useRef<HTMLDivElement>(null);
    const [autoScroll, setAutoScroll] = useState(true);
    const autoScrollRef = useRef(autoScroll);
    autoScrollRef.current = autoScroll;

    useEffect(() => {
        api.getLogs().then(rows => {
            setLogs(rows);
            if (!logName && rows[0]?.Name) onNameChange(rows[0].Name);
        }).catch(e => setError(e instanceof Error ? e.message : 'Could not list log files.'));
    }, [api]);

    const loadLog = useCallback(async (reset = false) => {
        if (!logName) return;
        const request = reset ? ++generation.current : generation.current;
        if (reset) tail.current = { lines: [], length: 0 };
        setLoading(true);
        try {
            const text = await api.getLogText(logName);
            if (request !== generation.current) return;
            rawText.current = text;
            setError('');
            const next = appendLogText(tail.current, text);
            if (next === tail.current) return;
            tail.current = next;
            setTotalBytes(new Blob([text]).size);
            setLines(next.lines.map(parseLogLine));
            if (autoScrollRef.current && containerRef.current) {
                containerRef.current.scrollTop = containerRef.current.scrollHeight;
            }
        } catch (e) {
            if (request === generation.current) setError(e instanceof Error ? e.message : 'Could not load log.');
        } finally {
            if (request === generation.current) setLoading(false);
        }
    }, [api, logName]);

    useEffect(() => {
        setLines([]);
        setTotalBytes(0);
        if (!logName) return;
        void loadLog(true);
        return () => { generation.current += 1; };
    }, [logName, loadLog]);

    useEffect(() => {
        if (!logName || paused) return;
        const timer = window.setInterval(() => { if (!document.hidden) void loadLog(); }, 3000);
        return () => window.clearInterval(timer);
    }, [logName, paused, loadLog]);

    const filtered = search.trim()
        ? lines.filter(l => l.text.toLowerCase().includes(search.toLowerCase()))
        : lines;
    const visible = filtered.slice(-500);
    const download = () => {
        const url = URL.createObjectURL(new Blob([rawText.current], { type: 'text/plain;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = url; link.download = logName || 'jellyfin.log'; link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    const copy = async () => {
        const text = filtered.map(line => line.text).join('\n');
        try {
            await navigator.clipboard.writeText(text);
            setCopied(`Copied ${filtered.length} lines.`);
        } catch {
            setCopied('Copy failed. Download the log instead.');
        }
        window.setTimeout(() => setCopied(''), 3000);
    };

    return <div class="llv">
        <div class="ad-toolbar">
            <select class="ad-select" value={logName} onChange={e => onNameChange(e.currentTarget.value)} aria-label="Choose log file">
                {logs.map(l => <option key={l.Name} value={l.Name}>{l.Name} · {fmtSize(l.Size || 0)}</option>)}
            </select>
            <button class="ad-btn" onClick={() => void loadLog(true)}>
                {loading ? 'Loading…' : '⟳ Reload'}
            </button>
            <button class="ad-btn" disabled={!rawText.current} onClick={download}>Download</button>
            <button class="ad-btn" disabled={filtered.length === 0} onClick={() => void copy()}>{search.trim() ? 'Copy matching lines' : 'Copy lines'}</button>
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
        {copied && <p class="ad-note" role="status">{copied}</p>}
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

function highlight(query: string, text: string): any {
    if (!query.trim()) return text;
    const parts = text.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));
    return parts.map((part, i) => part.toLowerCase() === query.toLowerCase() ? <mark key={i}>{part}</mark> : part);
}

function fmtSize(size: number): string {
    return size >= 1024 ** 2 ? `${(size / 1024 ** 2).toFixed(1)} MB` : `${Math.round(size / 1024)} KB`;
}