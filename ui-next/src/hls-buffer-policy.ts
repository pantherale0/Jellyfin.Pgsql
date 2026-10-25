import { hlsBufferPolicy, type HlsBufferPolicy, type HlsBufferPolicyInput } from './player-model';

export interface HlsManifestLevel {
    maxBitrate: number;
}

export interface HlsPlayerConfig extends HlsBufferPolicy {
    startPosition: number;
    enableInterstitialPlayback: false;
}

export function createHlsPlayerConfig(input: HlsBufferPolicyInput, startPosition: number): HlsPlayerConfig {
    return {
        ...hlsBufferPolicy(input),
        startPosition,
        enableInterstitialPlayback: false
    };
}

export function registerHlsManifestBufferPolicy(
    config: HlsBufferPolicy,
    onManifestParsed: (listener: (levels: readonly HlsManifestLevel[]) => void) => void,
    input: HlsBufferPolicyInput
): void {
    onManifestParsed(levels => {
        Object.assign(config, hlsBufferPolicy({
            ...input,
            manifestBitrates: levels.map(level => level.maxBitrate)
        }));
    });
}
