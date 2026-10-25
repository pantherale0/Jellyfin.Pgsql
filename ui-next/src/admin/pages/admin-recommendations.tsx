import { useCallback, useEffect, useState } from 'preact/hooks';
import type { AdminApi } from '../admin-api';
import type { TasteShadowEval, TasteEvalRun, ScheduledTask } from '../types';
import { PageShell, Card, StatusChip, Empty, InfoRow, DataTable } from '../ui';
import { t } from '../../i18n';

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

    return <PageShell title={t('Recommendations')} subtitle={t('Taste engine, For You and Seerr')} actions={refreshTask && <button class="ad-btn" disabled={refreshTask.State === 'Running'} onClick={async () => { try { await api.startTask(refreshTask.Id); setMessage(t('Recommendation rebuild requested.')); const task = await api.getScheduledTask(refreshTask.Id); setRefreshTask(task); } catch (e) { setMessage(e instanceof Error ? e.message : t('Could not start rebuild.')); } }}>{t('Refresh recommendations')}</button>}>
        {message && <p role="status" class="ad-note">{message}</p>}
        {refreshTask?.State === 'Running' && <Card title={t('Recommendation rebuild')}><InfoRow k={t('State')} v={refreshTask.State} />{refreshTask.CurrentProgressPercentage != null && <div class="ad-progress" role="progressbar" aria-valuenow={refreshTask.CurrentProgressPercentage} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${Math.min(100, refreshTask.CurrentProgressPercentage)}%` }} /></div>}</Card>}
        <Card title={t('Taste & For You')}>
            {!taste ? <Empty muted>{t('Taste evaluation data is unavailable.')}</Empty> : <>
                <InfoRow k={t('Taste profiles')} v={<StatusChip tone={enabled ? 'green' : 'muted'}>{enabled ? t('Enabled') : t('Disabled')}</StatusChip>} />
                <InfoRow k={t('Shadow training')} v={status?.ShadowTrainingEnabled == null ? t('Not reported') : status.ShadowTrainingEnabled ? t('Enabled') : t('Disabled')} />
                <InfoRow k={t('Neural serving')} v={status?.NeuralServingEnabled == null ? t('Not reported') : status.NeuralServingEnabled ? t('Enabled') : t('Disabled')} />
                {latest?.CreatedAt && <InfoRow k={t('Last evaluation')} v={new Date(latest.CreatedAt).toLocaleString()} />}
                {latest?.PrecisionAt10 != null && <InfoRow k={t('Precision@10')} v={latest.PrecisionAt10.toFixed(3)} />}
                {status?.ForYouEngageRate != null && <InfoRow k={t('For You engage rate')} v={`${(status.ForYouEngageRate * 100).toFixed(1)}%${status.ForYouEngageWindowDays ? ` over ${status.ForYouEngageWindowDays} days` : ''}${status.ForYouImpressionCount != null ? ` (${status.ForYouEngageCount ?? 0} of ${status.ForYouImpressionCount} impressions)` : ''}`} />}
                {latest?.Auc != null && <InfoRow k="AUC" v={metric(latest.Auc)} />}
                {latest?.Accuracy != null && <InfoRow k={t('Accuracy')} v={percent(latest.Accuracy)} />}
                {latest?.MeanPrecisionAt10 != null && <InfoRow k={t('Macro precision@10')} v={metric(latest.MeanPrecisionAt10)} />}
                {latest?.Notes && <InfoRow k={t('Notes')} v={latest.Notes} />}
                {status?.NeuralModelLoaded && <InfoRow k={t('Model')} v={<StatusChip tone="green">{t('Loaded')}</StatusChip>} />}
            </>}
        </Card>
        {taste && <Card title={t('Evaluation history')}>
            <DataTable rows={taste.Runs || []} getKey={(run: TasteEvalRun) => run.Id || run.CreatedAt || ''} empty={t('No evaluation runs recorded')} query="" columns={[
                { key: 'When', label: t('Run'), value: (run: TasteEvalRun) => run.CreatedAt ? new Date(run.CreatedAt).toLocaleString() : '—', searchValue: (run: TasteEvalRun) => run.CreatedAt || '' },
                { key: 'Result', label: t('Result'), value: (run: TasteEvalRun) => <StatusChip tone={!run.Succeeded ? 'red' : run.Auc == null && run.PrecisionAt10 == null ? 'muted' : 'green'}>{!run.Succeeded ? t('Failed') : run.Auc == null && run.PrecisionAt10 == null ? t('Skipped') : t('Evaluated')}</StatusChip> },
                { key: 'Auc', label: 'AUC', value: (run: TasteEvalRun) => metric(run.Auc) },
                { key: 'Accuracy', label: t('Accuracy'), value: (run: TasteEvalRun) => percent(run.Accuracy) },
                { key: 'P10', label: t('P@10 / macro'), value: (run: TasteEvalRun) => `${metric(run.PrecisionAt10)} / ${metric(run.MeanPrecisionAt10)}` },
                { key: 'Holdout', label: t('Holdout'), value: (run: TasteEvalRun) => <>{t('{0} held out · {1} trained', run.HoldoutCount ?? 0, run.TrainCount ?? 0)}<div class="ad-cell-sub">{[ run.SplitType, run.HoldoutFraction != null ? `${(run.HoldoutFraction * 100).toFixed(0)}%` : '', `${run.PositiveCount ?? 0}+ / ${run.NegativeCount ?? 0}−` ].filter(Boolean).join(' · ')}</div></> },
                { key: 'Engage', label: t('For You engage'), value: (run: TasteEvalRun) => run.ForYouEngageRate == null ? '—' : `${percent(run.ForYouEngageRate)}${run.ForYouEngageWindowDays ? ` · ${run.ForYouEngageWindowDays}d` : ''}` },
                { key: 'Notes', label: t('Notes'), value: (run: TasteEvalRun) => run.Notes || '' },
            ]} />
        </Card>}
        <Card title={t('Seerr / Beyond Your Library')}>
            {seerrConfigured ? <InfoRow k={t('Configuration')} v={<StatusChip tone="blue">{t('Enabled')}</StatusChip>} /> : <Empty muted>{seerr ? t('Seerr is not configured.') : t('Seerr status endpoint is unavailable.')}</Empty>}
            {seerrConfigured && <p class="ad-note">{t('The current API reports configuration only; remote connection health and request queue counts are not exposed.')}</p>}
        </Card>
        {!refreshTask && <Empty muted>{t('No recommendation refresh task was reported by this server.')}</Empty>}
    </PageShell>;
}
