import { t } from '../i18n';
import { Card, StatusChip } from './ui';
import type { KnownPipelineFramework, KnownPipelineStageType, PipelineLabel, PipelineStage, PipelineView } from './types';

function stageTypeLabel(type: PipelineLabel<KnownPipelineStageType>): string {
    if (type.kind === 'unknown') return type.label ?? t('Unknown stage');
    switch (type.value) {
        case 'Decode': return t('Decode');
        case 'Scale': return t('Scale');
        case 'Deinterlace': return t('Deinterlace');
        case 'ToneMap': return t('Tone map');
        case 'Subtitle': return t('Subtitle');
        case 'Format': return t('Format');
        case 'Encode': return t('Encode');
        default: {
            const _exhaustive: never = type.value;
            return _exhaustive;
        }
    }
}

function mediaTypeLabel(mediaType: PipelineStage['mediaType']): string | null {
    if (!mediaType) return null;
    if (mediaType.kind === 'unknown') return mediaType.label ?? t('Unknown media type');
    return mediaType.value === 'Video' ? t('Video') : t('Audio');
}

function frameworkLabel(framework: PipelineLabel<KnownPipelineFramework>): string {
    if (framework.kind === 'unknown') return framework.label ?? t('Unknown framework');
    switch (framework.value) {
        case 'Software': return t('Software');
        case 'Qsv': return 'Intel QSV';
        case 'Cuda': return 'CUDA';
        case 'Vaapi': return 'VAAPI';
        case 'D3D11Va': return 'D3D11VA';
        case 'VideoToolbox': return 'VideoToolbox';
        case 'Amf': return 'AMD AMF';
        case 'OpenCl': return 'OpenCL';
        case 'Vulkan': return 'Vulkan';
        case 'Rkmpp': return 'Rockchip MPP';
        case 'AudioToolbox': return 'AudioToolbox';
        case 'V4l2m2m': return 'V4L2 M2M';
        default: {
            const _exhaustive: never = framework.value;
            return _exhaustive;
        }
    }
}

function PipelineStageCard({ stage, index, isLast }: { stage: PipelineStage; index: number; isLast: boolean }) {
    const type = stageTypeLabel(stage.type);
    const heading = stage.detail || stage.name || type;
    const mediaType = mediaTypeLabel(stage.mediaType);
    const framework = frameworkLabel(stage.framework);

    return <li class="ad-pipeline-stage">
        <article class="ad-pipeline-node">
            <div class="ad-pipeline-node-head">
                <span class="ad-pipeline-step" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                <span class="ad-pipeline-kind">{type}</span>
                {mediaType && <span class="ad-pipeline-media">{mediaType}</span>}
            </div>
            <strong class="ad-pipeline-heading">{heading}</strong>
            {stage.name && stage.detail && <code class="ad-pipeline-name">{stage.name}</code>}
            <div class="ad-pipeline-meta">
                <span>{framework}</span>
                {stage.isHardware !== null && <StatusChip tone={stage.isHardware ? 'blue' : 'muted'}>{stage.isHardware ? t('Hardware') : t('Software')}</StatusChip>}
            </div>
            {isLast && stage.edgeLabel && <div class="ad-pipeline-output"><span>{t('Output')}</span><code>{stage.edgeLabel}</code></div>}
        </article>
        {!isLast && <div class="ad-pipeline-connector" data-testid="pipeline-connector">
            <span class="ad-pipeline-arrow" aria-hidden="true" />
            {stage.edgeLabel && <span class="ad-pipeline-edge-label">{stage.edgeLabel}</span>}
        </div>}
    </li>;
}

export function TranscodingPipelineGraph({ pipeline }: { pipeline: PipelineView }) {
    if (pipeline.kind === 'unavailable') {
        return <Card title={t('Transcoding pipeline')}>
            <p class="ad-note" role="status">{pipeline.reason === 'empty' ? t('No pipeline stages were reported.') : t('Pipeline details are not available for this session.')}</p>
        </Card>;
    }

    return <Card title={t('Transcoding pipeline')}>
        <div class="ad-pipeline-scroll" role="region" aria-label={t('Transcoding pipeline stages')} tabIndex={0}>
            <ol class="ad-pipeline-flow">
                {pipeline.stages.map((stage, index) => <PipelineStageCard key={`${index}:${stage.name || stage.detail || 'stage'}`} stage={stage} index={index} isLast={index === pipeline.stages.length - 1} />)}
            </ol>
        </div>
    </Card>;
}
