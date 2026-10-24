import type {
    KnownPipelineFramework,
    KnownPipelineStageType,
    PipelineLabel,
    PipelineMediaType,
    PipelineStage,
    PipelineView,
} from './types';

type WireObject = Record<string, unknown>;

function isObject(value: unknown): value is WireObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
    if (typeof value === 'string') return value.trim() || null;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return null;
}

function isKnownStageType(value: string): value is KnownPipelineStageType {
    switch (value) {
        case 'Decode':
        case 'Scale':
        case 'Deinterlace':
        case 'ToneMap':
        case 'Subtitle':
        case 'Format':
        case 'Encode':
            return true;
        default:
            return false;
    }
}

function parseStageType(value: unknown): PipelineLabel<KnownPipelineStageType> {
    const label = stringValue(value);
    if (!label || label === 'Unknown') return { kind: 'unknown', label: null };
    return isKnownStageType(label) ? { kind: 'known', value: label } : { kind: 'unknown', label };
}

function isKnownFramework(value: string): value is KnownPipelineFramework {
    switch (value) {
        case 'Software':
        case 'Qsv':
        case 'Cuda':
        case 'Vaapi':
        case 'D3D11Va':
        case 'VideoToolbox':
        case 'Amf':
        case 'OpenCl':
        case 'Vulkan':
        case 'Rkmpp':
        case 'AudioToolbox':
        case 'V4l2m2m':
            return true;
        default:
            return false;
    }
}

function parseFramework(value: unknown): PipelineLabel<KnownPipelineFramework> {
    const label = stringValue(value);
    if (!label) return { kind: 'unknown', label: null };
    return isKnownFramework(label) ? { kind: 'known', value: label } : { kind: 'unknown', label };
}

function parseMediaType(value: unknown): PipelineMediaType {
    if (value === undefined || value === null) return null;
    const label = stringValue(value);
    if (label === 'Video' || label === 'Audio') return { kind: 'known', value: label };
    return { kind: 'unknown', label };
}

function parseText(value: unknown): string | null {
    return typeof value === 'string' ? value.trim() || null : null;
}

function parseStage(value: unknown): PipelineStage {
    if (!isObject(value)) {
        return {
            type: { kind: 'unknown', label: null },
            mediaType: null,
            framework: { kind: 'unknown', label: null },
            name: null,
            detail: null,
            isHardware: null,
            edgeLabel: null,
        };
    }

    return {
        type: parseStageType(value.Type),
        mediaType: parseMediaType(value.MediaType),
        framework: parseFramework(value.Framework),
        name: parseText(value.Name),
        detail: parseText(value.Detail),
        isHardware: typeof value.IsHardware === 'boolean' ? value.IsHardware : null,
        edgeLabel: parseText(value.EdgeLabel),
    };
}

export function parseTranscodingPipeline(value: unknown): PipelineView {
    if (value === undefined || value === null) return { kind: 'unavailable', reason: 'not-reported' };
    if (!isObject(value) || !Array.isArray(value.Stages)) return { kind: 'unavailable', reason: 'invalid' };

    const parsedStages = value.Stages.map(parseStage);
    const [first, ...rest] = parsedStages;
    if (!first) return { kind: 'unavailable', reason: 'empty' };
    return { kind: 'available', stages: [first, ...rest] };
}
