import { useCallback, useEffect, useState } from 'preact/hooks';
import type { AdminApi } from '../admin-api';
import type { TasteShadowEval, TasteEvalRun, ScheduledTask } from '../types';
import { PageShell, Card, StatusChip, Empty, InfoRow, DataTable } from '../ui';

const metric = (value?: number | null, digits = 3) => value == null ? '—' : value.toFixed(digits);
const percent = (value?: number | null) => value == null ? '—' : `${(value * 100).toFixed(1)}%`;

export function AdminRecommendations({ adminApi: api }: { adminApi: AdminApi }) {
    const [taste, setTaste] = useState<TasteShadowEval | null>(null);
    const [seerr, setSeerr] = useState<{ enabled: boolean } | null>(null);
    const [refreshTask, setRefreshTask] = useState<ScheduledTask | null>(null);
    const [message, setMessage] = useState('');
    const load = useCallback(async () => {
        const [t, s, tasks] = await Promise.all([api.getTasteShadowEval().catch(() => null), api.getSeerrStatus().catch(() => null), api.getScheduledTasks().catch(() => [])]);
        setTaste(t); setSeerr(s); setRefreshTask(tasks.find(t => t.Key === 'RebuildUserTasteRecommendations') || null);
    }, [api]);
    useEffect(() => { load(); }, [load]);
    useEffect(() => {
        if (refreshTask?.State !== 'Running') return;
        let active = true;
        const timer = window.setInterval(async () => {
            const task = await api.getScheduledTask(refreshTask.Id).catch(() => null);
            if (active && task) { setRefreshTask(task); if (task.State !== 'Running') void load(); }
        }, 5000);
        return () => { active = false; window.clearInterval(timer); };
    }, [api, refreshTask?.State, refreshTask?.Id]);

    const status = taste?.Status;
    const latest = taste?.Latest;
    const enabled = status?.TasteEnabled === true;
    const seerrConfigured = seerr?.enabled === true;

    return <PageShell title="Recommendations" subtitle="Taste engine, For You and Seerr" actions={refreshTask && <button class="ad-btn" disabled={refreshTask.State === 'Running'} onClick={async () => { try { await api.startTask(refreshTask.Id); setMessage('Recommendation rebuild requested.'); const task = await api.getScheduledTask(refreshTask.Id); setRefreshTask(task); } catch (e) { setMessage(e instanceof Error ? e.message : 'Could not start rebuild.'); } }}>Refresh recommendations</button>}>
        {message && <p role="status" class="ad-note">{message}</p>}
        {refreshTask?.State === 'Running' && <Card title="Recommendation rebuild"><InfoRow k="State" v={refreshTask.State} />{refreshTask.CurrentProgressPercentage != null && <div class="ad-progress" role="progressbar" aria-valuenow={refreshTask.CurrentProgressPercentage} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${Math.min(100, refreshTask.CurrentProgressPercentage)}%` }} /></div>}</Card>}
        <Card title="Taste & For You">
            {!taste ? <Empty muted>Taste evaluation data is unavailable.</Empty> : <>
                <InfoRow k="Taste profiles" v={<StatusChip tone={enabled ? 'green' : 'muted'}>{enabled ? 'Enabled' : 'Disabled'}</StatusChip>} />
                <InfoRow k="Shadow training" v={status?.ShadowTrainingEnabled == null ? 'Not reported' : status.ShadowTrainingEnabled ? 'Enabled' : 'Disabled'} />
                <InfoRow k="Neural serving" v={status?.NeuralServingEnabled == null ? 'Not reported' : status.NeuralServingEnabled ? 'Enabled' : 'Disabled'} />
                {latest?.CreatedAt && <InfoRow k="Last evaluation" v={new Date(latest.CreatedAt).toLocaleString()} />}
                {latest?.PrecisionAt10 != null && <InfoRow k="Precision@10" v={latest.PrecisionAt10.toFixed(3)} />}
                {status?.ForYouEngageRate != null && <InfoRow k="For You engage rate" v={`${(status.ForYouEngageRate * 100).toFixed(1)}%${status.ForYouEngageWindowDays ? ` over ${status.ForYouEngageWindowDays} days` : ''}${status.ForYouImpressionCount != null ? ` (${status.ForYouEngageCount ?? 0} of ${status.ForYouImpressionCount} impressions)` : ''}`} />}
                {latest?.Auc != null && <InfoRow k="AUC" v={metric(latest.Auc)} />}
                {latest?.Accuracy != null && <InfoRow k="Accuracy" v={percent(latest.Accuracy)} />}
                {latest?.MeanPrecisionAt10 != null && <InfoRow k="Macro precision@10" v={metric(latest.MeanPrecisionAt10)} />}
                {latest?.Notes && <InfoRow k="Notes" v={latest.Notes} />}
                {status?.NeuralModelLoaded && <InfoRow k="Model" v={<StatusChip tone="green">Loaded</StatusChip>} />}
            </>}
        </Card>
        {taste && <Card title="Evaluation history">
            <DataTable rows={taste.Runs || []} getKey={(run: TasteEvalRun) => run.Id || run.CreatedAt || ''} empty="No evaluation runs recorded" query="" columns={[
                { key: 'When', label: 'Run', value: (run: TasteEvalRun) => run.CreatedAt ? new Date(run.CreatedAt).toLocaleString() : '—', searchValue: (run: TasteEvalRun) => run.CreatedAt || '' },
                { key: 'Result', label: 'Result', value: (run: TasteEvalRun) => <StatusChip tone={!run.Succeeded ? 'red' : run.Auc == null && run.PrecisionAt10 == null ? 'muted' : 'green'}>{!run.Succeeded ? 'Failed' : run.Auc == null && run.PrecisionAt10 == null ? 'Skipped' : 'Evaluated'}</StatusChip> },
                { key: 'Auc', label: 'AUC', value: (run: TasteEvalRun) => metric(run.Auc) },
                { key: 'Accuracy', label: 'Accuracy', value: (run: TasteEvalRun) => percent(run.Accuracy) },
                { key: 'P10', label: 'P@10 / macro', value: (run: TasteEvalRun) => `${metric(run.PrecisionAt10)} / ${metric(run.MeanPrecisionAt10)}` },
                { key: 'Holdout', label: 'Holdout', value: (run: TasteEvalRun) => <>{run.HoldoutCount ?? 0} held out · {run.TrainCount ?? 0} trained<div class="ad-cell-sub">{[ run.SplitType, run.HoldoutFraction != null ? `${(run.HoldoutFraction * 100).toFixed(0)}%` : '', `${run.PositiveCount ?? 0}+ / ${run.NegativeCount ?? 0}−` ].filter(Boolean).join(' · ')}</div></> },
                { key: 'Engage', label: 'For You engage', value: (run: TasteEvalRun) => run.ForYouEngageRate == null ? '—' : `${percent(run.ForYouEngageRate)}${run.ForYouEngageWindowDays ? ` · ${run.ForYouEngageWindowDays}d` : ''}` },
                { key: 'Notes', label: 'Notes', value: (run: TasteEvalRun) => run.Notes || '' },
            ]} />
        </Card>}
        <Card title="Seerr / Beyond Your Library">
            {seerrConfigured ? <InfoRow k="Configuration" v={<StatusChip tone="blue">Enabled</StatusChip>} /> : <Empty muted>{seerr ? 'Seerr is not configured.' : 'Seerr status endpoint is unavailable.'}</Empty>}
            {seerrConfigured && <p class="ad-note">The current API reports configuration only; remote connection health and request queue counts are not exposed.</p>}
        </Card>
        {!refreshTask && <Empty muted>No recommendation refresh task was reported by this server.</Empty>}
    </PageShell>;
}
