export interface PlaybackReport {
    ItemId: string;
    MediaSourceId?: string;
    PlaySessionId?: string;
    PositionTicks: number;
    CanSeek: boolean;
    IsPaused: boolean;
    IsMuted: boolean;
    VolumeLevel: number;
    AudioStreamIndex: number | null;
    SubtitleStreamIndex: number | null;
    PlayMethod: 'DirectPlay' | 'Transcode';
    PlaybackStartTimeTicks: number;
    RepeatMode: 'RepeatNone';
    PlaybackOrder: 'Default';
    NowPlayingQueue: Array<{ Id: string }>;
    AspectRatio?: string;
    Failed?: boolean;
}

export interface PlaybackSample {
    itemId: string;
    mediaSourceId?: string;
    playSessionId?: string;
    positionSeconds: number;
    durationSeconds: number;
    paused: boolean;
    muted: boolean;
    volume: number;
    audioStreamIndex: number | null;
    subtitleStreamIndex: number | null;
    playMethod: 'DirectPlay' | 'Transcode';
    aspectRatio?: string;
    startedAtMs: number;
}

interface Clock {
    now: () => number;
    setTimeout: (handler: () => void, ms: number) => number;
    clearTimeout: (handle: number) => void;
    setInterval: (handler: () => void, ms: number) => number;
    clearInterval: (handle: number) => void;
}

const browserClock: Clock = {
    now: () => Date.now(),
    setTimeout: (handler, ms) => window.setTimeout(handler, ms),
    clearTimeout: handle => window.clearTimeout(handle),
    setInterval: (handler, ms) => window.setInterval(handler, ms),
    clearInterval: handle => window.clearInterval(handle)
};

export function positionTicks(seconds: number): number {
    if (!Number.isFinite(seconds) || seconds <= 0) return 0;
    return Math.round(seconds * 10_000_000);
}

export function playbackReport(sample: PlaybackSample, failed = false): PlaybackReport {
    const report: PlaybackReport = {
        ItemId: sample.itemId,
        MediaSourceId: sample.mediaSourceId,
        PlaySessionId: sample.playSessionId,
        PositionTicks: positionTicks(sample.positionSeconds),
        CanSeek: Number.isFinite(sample.durationSeconds) && sample.durationSeconds > 0,
        IsPaused: sample.paused,
        IsMuted: sample.muted || sample.volume <= 0,
        VolumeLevel: Math.round(Math.min(1, Math.max(0, sample.muted ? 0 : sample.volume)) * 100),
        AudioStreamIndex: sample.audioStreamIndex,
        SubtitleStreamIndex: sample.subtitleStreamIndex,
        PlayMethod: sample.playMethod,
        PlaybackStartTimeTicks: Math.round(sample.startedAtMs * 10_000),
        RepeatMode: 'RepeatNone',
        PlaybackOrder: 'Default',
        NowPlayingQueue: [ { Id: sample.itemId } ],
        AspectRatio: sample.aspectRatio
    };
    if (failed) report.Failed = true;
    return report;
}

export class PlaybackReporter {
    private started = false;
    private stopSent = false;
    private lastSent = 0;
    private trailing: number | undefined;
    private interval: number | undefined;
    private readonly read: () => PlaybackSample;
    private readonly transport: {
        start: (report: PlaybackReport) => Promise<void> | void;
        progress: (report: PlaybackReport) => Promise<void> | void;
        stop: (report: PlaybackReport, keepalive: boolean) => Promise<void> | void;
    };
    private readonly clock: Clock;

    constructor(
        read: () => PlaybackSample,
        transport: {
            start: (report: PlaybackReport) => Promise<void> | void;
            progress: (report: PlaybackReport) => Promise<void> | void;
            stop: (report: PlaybackReport, keepalive: boolean) => Promise<void> | void;
        },
        clock: Clock = browserClock
    ) {
        this.read = read;
        this.transport = transport;
        this.clock = clock;
    }

    get isStarted(): boolean {
        return this.started && !this.stopSent;
    }

    start(): void {
        if (this.started || this.stopSent) return;
        this.started = true;
        this.lastSent = this.clock.now();
        void this.transport.start(playbackReport(this.read()));
        this.interval = this.clock.setInterval(() => {
            if (!this.isStarted || this.read().paused) return;
            this.sendProgress();
        }, 10_000);
    }

    pulse(): void {
        if (!this.isStarted) return;
        const wait = 1000 - (this.clock.now() - this.lastSent);
        if (wait <= 0) {
            this.sendProgress();
            return;
        }
        if (this.trailing !== undefined) return;
        this.trailing = this.clock.setTimeout(() => {
            this.trailing = undefined;
            if (this.isStarted) this.sendProgress();
        }, wait);
    }

    stop(failed = false, keepalive = false): void {
        if (!this.started || this.stopSent) return;
        this.stopSent = true;
        this.clearTimers();
        void this.transport.stop(playbackReport(this.read(), failed), keepalive);
    }

    resumeAfterHide(): void {
        if (!this.stopSent) return;
        this.stopSent = false;
        this.started = false;
        this.start();
    }

    private sendProgress(): void {
        if (!this.isStarted) return;
        this.lastSent = this.clock.now();
        void this.transport.progress(playbackReport(this.read()));
    }

    private clearTimers(): void {
        if (this.trailing !== undefined) {
            this.clock.clearTimeout(this.trailing);
            this.trailing = undefined;
        }
        if (this.interval !== undefined) {
            this.clock.clearInterval(this.interval);
            this.interval = undefined;
        }
    }
}
