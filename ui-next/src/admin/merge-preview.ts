export type MergeTransferMode = 'merge' | 'move';

export interface MergePreviewIdentity {
    sourceId: string;
    targetId: string;
    requestId: number;
    mode: MergeTransferMode;
}

export function isMergePreviewCurrent(
    preview: MergePreviewIdentity | null | undefined,
    sourceId: string,
    targetId: string,
    requestId: number,
    mode: MergeTransferMode = 'merge'
): boolean {
    if (!preview || !sourceId || !targetId) return false;
    return preview.sourceId === sourceId && preview.targetId === targetId && preview.requestId === requestId && preview.mode === mode;
}
