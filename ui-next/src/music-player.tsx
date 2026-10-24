import type { Ref } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { JellyfinApi } from './api';
import type { MediaItem } from './types';
import type { PlaybackChoice } from './player-model';
import { PlaybackReporter, type PlaybackSample } from './playback-report';
import { addToQueue as appendToQueue, advance, audioQueueable, createQueue, cycleRepeat, emptyQueue, jumpTo, moveInQueue, playNext as insertNext, previous as previousInQueue, removeFromQueue, toggleShuffle, type PlayQueue } from './play-queue';
import { continuesAlbum, crossfadeEnvelope, elementVolume, formatDuration, isAudioItem, MAX_TRACK_FAILURES, mediaPositionState, mediaSessionMetadata, normalizationDb, planTransition, previousGoesBack, trackArtist } from './music-model';
import { loadMusicSettings, saveMusicSettings, type MusicSettings } from './music-settings';
import { hasNativeShell, hideHostMediaSession, hostMediaSessionInfo, updateHostMediaSession } from './native-host';
import { userMessage } from './ui-errors';
import { t } from './i18n';

interface Loaded {
    item: MediaItem;
    choice: PlaybackChoice;
    deck: HTMLAudioElement;
    reporter: PlaybackReporter | null;
    ready: boolean;
    envelope: number;
    startedAtMs: number;
}

export interface MusicSnapshot {
    queue: PlayQueue;
    current: MediaItem | null;
    playing: boolean;
    loading: boolean;
    /** Stopped for a video or at the end of the queue; Play starts again from `resumeAt`. */
    suspended: boolean;
    notice: string;
    volume: number;
    volumeControl: boolean;
}

export interface MusicPosition { position: number; duration: number }

const ticksToSeconds = (ticks: number | undefined) => ticks ? ticks / 10_000_000 : 0;

/** Album art for a track: its own image, else the album's. */
export function trackImageUrl(api: JellyfinApi | null, item: MediaItem | null, width = 600): string {
    if (!api || !item) return '';
    const own = api.imageUrl(item, 'Primary', width);
    if (own) return own;
    if (!item.AlbumId || !item.AlbumPrimaryImageTag) return '';
    return api.imageUrl({ Id: item.AlbumId, Name: item.Album || '', ImageTags: { Primary: item.AlbumPrimaryImageTag } }, 'Primary', width);
}

/**
 * Root-mounted music playback on two alternating audio elements: one plays while the other
 * preloads the next track, which gives near-gapless changes and crossfades. Volume (user,
 * normalization and fade) goes through `element.volume`, so no Web Audio CORS is involved.
 */
export class MusicEngine {
    private api: JellyfinApi | null = null;
    private decks: HTMLAudioElement[] = [];
    private active = 0;
    private current: Loaded | null = null;
    private pending: Loaded | null = null;
    private pendingFor: MediaItem | null = null;
    private pendingRequest = 0;
    private generation = 0;
    private fade: { from: Loaded; to: Loaded; startedAt: number; seconds: number; timer: number } | null = null;
    private settings: MusicSettings = loadMusicSettings();
    private gains: Record<string, number> = {};
    private failures = 0;
    private resumeAt = 0;
    private lastSessionUpdate = 0;
    private lastHostUpdate = 0;
    private listeners = new Set<(snapshot: MusicSnapshot) => void>();
    private positionListeners = new Set<() => void>();
    private volumeControl = true;
    snapshot: MusicSnapshot = { queue: emptyQueue(), current: null, playing: false, loading: false, suspended: false, notice: '', volume: this.settings.volume, volumeControl: true };

    constructor() {
        if (typeof window === 'undefined') return;
        window.addEventListener('ui-next-music', () => {
            this.settings = loadMusicSettings();
            this.reapplyVolumes();
            this.emit({ volume: this.settings.volume });
        });
        window.addEventListener('pagehide', () => this.current?.reporter?.stop(false, true));
        this.bindMediaSession();
    }

    attach(api: JellyfinApi | null): void {
        if (api === this.api) return;
        if (this.api) this.stop();
        this.api = api;
    }

    subscribe(listener: (snapshot: MusicSnapshot) => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    subscribePosition(listener: () => void): () => void {
        this.positionListeners.add(listener);
        return () => { this.positionListeners.delete(listener); };
    }

    position(): MusicPosition {
        const loaded = this.current;
        if (!loaded) {
            const item = this.snapshot.current;
            return { position: this.resumeAt, duration: ticksToSeconds(item?.RunTimeTicks) };
        }
        return { position: this.positionOf(loaded), duration: this.durationOf(loaded) };
    }

    /** Debug and smoke-test view of the decks. */
    inspect(): { active: number; decks: Array<{ src: string; paused: boolean; volume: number }>; pendingId: string | null; fading: boolean } {
        return {
            active: this.active,
            decks: this.decks.map(deck => ({ src: deck.getAttribute('src') || '', paused: deck.paused, volume: deck.volume })),
            pendingId: this.pending?.item.Id || null,
            fading: !!this.fade,
        };
    }

    // ---- Queue entry points -------------------------------------------------------------

    playTracks(items: MediaItem[], startIndex = 0, options: { shuffle?: boolean } = {}): void {
        const created = createQueue(items, options.shuffle ? -1 : startIndex, { accept: audioQueueable, shuffle: options.shuffle, repeat: this.snapshot.queue.repeat });
        if (!created) {
            this.emit({ notice: t('There is nothing to play here.'), loading: false });
            return;
        }
        this.loadGains(created.queue.order);
        void this.startItem(created.queue, created.item, 0);
    }

    /** Plays a track, album, artist or genre; containers expand to their tracks first. */
    async playItem(item: MediaItem, options: { shuffle?: boolean } = {}): Promise<void> {
        const tracks = await this.tracksFor(item);
        if (tracks) this.playTracks(tracks, 0, options);
    }

    async instantMix(item: MediaItem): Promise<void> {
        if (!this.api) return;
        const generation = this.generation;
        this.emit({ loading: true, notice: '' });
        try {
            const tracks = await this.api.getInstantMix(item.Id);
            if (generation !== this.generation) return;
            if (!tracks.some(audioQueueable)) {
                this.emit({ loading: false, notice: t('Jellyfin found no similar music for Instant Mix.') });
                return;
            }
            this.playTracks(tracks);
        } catch (error) {
            if (generation === this.generation) this.emit({ loading: false, notice: userMessage(error) });
        }
    }

    async playNext(item: MediaItem): Promise<void> {
        const tracks = await this.tracksFor(item);
        if (!tracks?.length) return;
        if (!this.snapshot.current) { this.playTracks(tracks); return; }
        let queue = this.snapshot.queue;
        tracks.slice().reverse().forEach(track => { queue = insertNext(queue, track, audioQueueable); });
        this.loadGains(tracks);
        this.setQueue(queue, tracks.length === 1 ? t('“{0}” plays next.', tracks[0].Name) : t('{0} tracks play next.', tracks.length));
    }

    async addToQueue(item: MediaItem): Promise<void> {
        const tracks = await this.tracksFor(item);
        if (!tracks?.length) return;
        if (!this.snapshot.current) { this.playTracks(tracks); return; }
        let queue = this.snapshot.queue;
        tracks.forEach(track => { queue = appendToQueue(queue, track, audioQueueable); });
        this.loadGains(tracks);
        this.setQueue(queue, tracks.length === 1 ? t('Added “{0}” to the music queue.', tracks[0].Name) : t('Added {0} tracks to the music queue.', tracks.length));
    }

    // ---- Transport ----------------------------------------------------------------------

    toggle(): void {
        const loaded = this.current;
        if (!loaded) {
            const item = this.snapshot.current;
            if (item) void this.startItem(this.snapshot.queue, item, this.resumeAt);
            return;
        }
        if (loaded.deck.paused) void loaded.deck.play().catch(error => this.playRejected(error));
        else {
            loaded.deck.pause();
            this.fade?.from.deck.pause();
        }
    }

    next(): void {
        const moved = advance(this.snapshot.queue, true);
        if (moved) this.go(moved.queue, moved.item);
    }

    previous(): void {
        if (this.current && !previousGoesBack(this.positionOf(this.current))) { this.seek(0); return; }
        const moved = previousInQueue(this.snapshot.queue);
        if (moved) this.go(moved.queue, moved.item);
        else this.seek(0);
    }

    seek(seconds: number): void {
        const loaded = this.current;
        if (!loaded) { this.resumeAt = Math.max(0, seconds); this.emitPosition(); return; }
        const target = Math.max(0, Math.min(seconds, this.durationOf(loaded) || seconds));
        this.cancelFade();
        this.discardPending();
        if (!loaded.choice.direct && !Number.isFinite(loaded.deck.duration)) {
            void this.startItem(this.snapshot.queue, loaded.item, target);
            return;
        }
        loaded.deck.currentTime = Math.max(0, target - loaded.choice.offsetSeconds);
        loaded.reporter?.pulse();
        this.emitPosition();
    }

    jump(index: number): void {
        const moved = jumpTo(this.snapshot.queue, index);
        if (moved) this.go(moved.queue, moved.item);
    }

    remove(index: number): void { this.setQueue(removeFromQueue(this.snapshot.queue, index)); }
    move(index: number, delta: -1 | 1): void { this.setQueue(moveInQueue(this.snapshot.queue, index, delta)); }
    toggleShuffle(): void { this.setQueue(toggleShuffle(this.snapshot.queue)); }
    cycleRepeat(): void { this.setQueue({ ...this.snapshot.queue, repeat: cycleRepeat(this.snapshot.queue.repeat) }); }

    setVolume(volume: number): void {
        this.settings = saveMusicSettings({ volume });
        this.reapplyVolumes();
        this.emit({ volume: this.settings.volume });
    }

    /** A video is starting: report music stopped, keep the queue, resume from here on Play. */
    suspend(): void {
        if (!this.current) return;
        this.resumeAt = this.positionOf(this.current);
        this.generation++;
        this.cancelFade();
        this.discardPending();
        this.retire(this.current);
        this.current = null;
        this.emit({ playing: false, loading: false, suspended: true });
        this.clearMediaSession();
    }

    /** Ends playback and clears the queue (sign-out, account switch, Clear queue). */
    stop(): void {
        this.generation++;
        this.cancelFade();
        this.discardPending();
        if (this.current) this.retire(this.current);
        this.current = null;
        this.resumeAt = 0;
        this.failures = 0;
        this.emit({ queue: emptyQueue(), current: null, playing: false, loading: false, suspended: false, notice: '' });
        this.clearMediaSession();
    }

    dismissNotice(): void { this.emit({ notice: '' }); }

    // ---- Internals ----------------------------------------------------------------------

    private emit(change: Partial<MusicSnapshot>): void {
        this.snapshot = { ...this.snapshot, ...change, volumeControl: this.volumeControl };
        this.listeners.forEach(listener => listener(this.snapshot));
    }

    private emitPosition(): void {
        this.positionListeners.forEach(listener => listener());
    }

    private setQueue(queue: PlayQueue, notice?: string): void {
        if (queue === this.snapshot.queue && notice === undefined) return;
        this.discardPending();
        this.emit(notice === undefined ? { queue } : { queue, notice });
    }

    private async tracksFor(item: MediaItem): Promise<MediaItem[] | null> {
        if (isAudioItem(item)) return [ item ];
        if (!this.api) return null;
        const generation = this.generation;
        this.emit({ loading: true, notice: '' });
        try {
            const tracks = item.Type === 'MusicAlbum' ? await this.api.getAlbumTracks(item.Id) : await this.api.getMusicTracks(item);
            if (generation !== this.generation) return null;
            const playable = tracks.filter(audioQueueable);
            this.emit({ loading: false, notice: playable.length ? '' : t('There is nothing to play here.') });
            return playable.length ? playable : null;
        } catch (error) {
            if (generation === this.generation) this.emit({ loading: false, notice: userMessage(error) });
            return null;
        }
    }

    private deck(index: number): HTMLAudioElement {
        if (!this.decks[index]) {
            const deck = document.createElement('audio');
            deck.preload = 'auto';
            deck.setAttribute('data-music-deck', String(index));
            deck.addEventListener('timeupdate', () => this.onTime(deck));
            deck.addEventListener('ended', () => this.onEnded(deck));
            deck.addEventListener('error', () => this.onError(deck));
            deck.addEventListener('playing', () => this.onPlaying(deck));
            deck.addEventListener('pause', () => this.onPause(deck));
            deck.addEventListener('loadedmetadata', () => { if (this.current?.deck === deck) this.emitPosition(); });
            if (index === 0) this.volumeControl = detectVolumeControl(deck);
            this.decks[index] = deck;
        }
        return this.decks[index];
    }

    private go(queue: PlayQueue, item: MediaItem): void {
        if (this.pending && this.pending.item === item && this.pending.ready && !this.fade) this.swapToPending(queue);
        else void this.startItem(queue, item, 0);
    }

    private async startItem(queue: PlayQueue, item: MediaItem, startSeconds: number): Promise<void> {
        const api = this.api;
        if (!api) return;
        const generation = ++this.generation;
        this.cancelFade();
        this.discardPending();
        if (this.current) this.retire(this.current);
        this.current = null;
        this.resumeAt = startSeconds;
        this.emit({ queue, current: item, loading: true, playing: false, suspended: false, notice: '' });
        let choice: PlaybackChoice;
        try {
            choice = await api.playAudio(item, { startTicks: Math.round(startSeconds * 10_000_000) });
        } catch (error) {
            if (generation === this.generation) this.trackFailed(item, userMessage(error));
            return;
        }
        if (generation !== this.generation) {
            void api.releasePlayback(choice).catch(() => undefined);
            return;
        }
        const loaded = this.load(item, choice, this.deck(this.active));
        this.current = loaded;
        this.applyVolume(loaded, 1);
        this.bindMediaSession();
        void loaded.deck.play().catch(error => this.playRejected(error));
        this.emit({ loading: false });
        this.updateMediaSession('playbackstart');
    }

    private load(item: MediaItem, choice: PlaybackChoice, deck: HTMLAudioElement): Loaded {
        const loaded: Loaded = { item, choice, deck, reporter: null, ready: false, envelope: 1, startedAtMs: Date.now() };
        deck.src = choice.url;
        if (choice.startSeconds > 0) {
            const seek = () => { deck.removeEventListener('loadedmetadata', seek); deck.currentTime = choice.startSeconds; };
            deck.addEventListener('loadedmetadata', seek);
        }
        const ready = () => { deck.removeEventListener('canplay', ready); loaded.ready = true; };
        deck.addEventListener('canplay', ready);
        deck.load();
        loaded.reporter = this.createReporter(loaded);
        return loaded;
    }

    private createReporter(loaded: Loaded): PlaybackReporter | null {
        const api = this.api;
        if (!api) return null;
        return new PlaybackReporter(() => this.sample(loaded), {
            start: report => api.reportPlaybackStart(report),
            progress: report => api.reportPlaybackProgress(report),
            stop: (report, keepalive) => api.reportPlaybackStopped(report, keepalive),
        });
    }

    private sample(loaded: Loaded): PlaybackSample {
        const queue = this.snapshot.queue;
        return {
            itemId: loaded.item.Id,
            mediaSourceId: loaded.choice.mediaSourceId,
            playSessionId: loaded.choice.playSessionId,
            positionSeconds: this.positionOf(loaded),
            durationSeconds: this.durationOf(loaded),
            paused: loaded.deck.paused,
            muted: loaded.deck.muted,
            volume: this.settings.volume,
            audioStreamIndex: loaded.choice.audioStreamIndex,
            subtitleStreamIndex: null,
            playMethod: loaded.choice.method,
            startedAtMs: loaded.startedAtMs,
            repeatMode: queue.repeat === 'all' ? 'RepeatAll' : queue.repeat === 'one' ? 'RepeatOne' : 'RepeatNone',
            shuffle: queue.shuffle,
            queueIds: queue.order.slice(0, 100).map(item => item.Id),
        };
    }

    private positionOf(loaded: Loaded): number {
        const time = loaded.deck.currentTime;
        return Math.max(0, (Number.isFinite(time) ? time : 0) + loaded.choice.offsetSeconds);
    }

    private durationOf(loaded: Loaded): number {
        const duration = loaded.deck.duration;
        return Number.isFinite(duration) && duration > 0 ? duration + loaded.choice.offsetSeconds : ticksToSeconds(loaded.item.RunTimeTicks);
    }

    /** The track that follows naturally; repeat-one replays in place, so it has no "next". */
    private peekNext(): MediaItem | null {
        const queue = this.snapshot.queue;
        const moved = advance(queue);
        if (!moved || moved.queue.position === queue.position) return null;
        return moved.item;
    }

    private onTime(deck: HTMLAudioElement): void {
        const loaded = this.current;
        if (!loaded || loaded.deck !== deck) return;
        this.emitPosition();
        const now = Date.now();
        if (now - this.lastSessionUpdate >= 1000) {
            this.lastSessionUpdate = now;
            setPositionState(mediaPositionState(this.positionOf(loaded), this.durationOf(loaded)));
        }
        if (now - this.lastHostUpdate >= 5000) this.updateHostSession('timeupdate');
        if (this.fade) return;
        const next = this.peekNext();
        if (!next) return;
        const position = this.positionOf(loaded);
        const plan = planTransition({
            currentDuration: this.durationOf(loaded),
            nextDuration: ticksToSeconds(next.RunTimeTicks) || Number.NaN,
            crossfadeSeconds: this.settings.crossfadeSeconds,
            gapless: this.settings.gapless,
            albumContinues: continuesAlbum(loaded.item, next),
            volumeControl: this.volumeControl,
        });
        if (position >= plan.preloadAt && this.pendingFor !== next) this.preload(next);
        if (plan.fadeSeconds > 0 && position >= plan.startAt && this.pending?.item === next && this.pending.ready) this.beginFade(plan.fadeSeconds);
    }

    private preload(next: MediaItem): void {
        const api = this.api;
        if (!api) return;
        this.discardPending();
        this.pendingFor = next;
        const request = this.pendingRequest;
        const generation = this.generation;
        void api.playAudio(next).then(choice => {
            if (request !== this.pendingRequest || generation !== this.generation) {
                void api.releasePlayback(choice).catch(() => undefined);
                return;
            }
            const loaded = this.load(next, choice, this.deck(1 - this.active));
            this.applyVolume(loaded, 0);
            this.pending = loaded;
        }).catch(() => {
            // The transition negotiates again and reports any failure then.
            if (request === this.pendingRequest) this.pendingFor = null;
        });
    }

    private discardPending(): void {
        this.pendingRequest++;
        this.pendingFor = null;
        const pending = this.pending;
        this.pending = null;
        if (pending) this.retire(pending);
    }

    private beginFade(seconds: number): void {
        const from = this.current;
        const to = this.pending;
        if (!from || !to) return;
        const moved = advance(this.snapshot.queue);
        if (!moved) return;
        this.pending = null;
        this.pendingFor = null;
        this.active = 1 - this.active;
        this.current = to;
        from.reporter?.stop();
        void to.deck.play().catch(error => this.playRejected(error));
        const startedAt = Date.now();
        const timer = window.setInterval(() => {
            const progress = (Date.now() - startedAt) / (seconds * 1000);
            const envelope = crossfadeEnvelope(progress);
            this.applyVolume(from, envelope.out);
            this.applyVolume(to, envelope.in);
            if (progress >= 1) this.cancelFade();
        }, 50);
        this.fade = { from, to, startedAt, seconds, timer };
        this.emit({ queue: moved.queue, current: to.item, notice: '' });
        this.updateMediaSession('playbackstart');
    }

    /** Ends any crossfade at once: the outgoing deck stops, the incoming one plays at full level. */
    private cancelFade(): void {
        const fade = this.fade;
        if (!fade) return;
        this.fade = null;
        window.clearInterval(fade.timer);
        this.retire(fade.from);
        this.applyVolume(fade.to, 1);
    }

    private swapToPending(queue: PlayQueue): void {
        const from = this.current;
        const to = this.pending;
        if (!to) return;
        this.pending = null;
        this.pendingFor = null;
        if (from) this.retire(from);
        this.active = 1 - this.active;
        this.current = to;
        this.applyVolume(to, 1);
        void to.deck.play().catch(error => this.playRejected(error));
        this.emit({ queue, current: to.item, notice: '' });
        this.updateMediaSession('playbackstart');
    }

    private onEnded(deck: HTMLAudioElement): void {
        if (this.fade?.from.deck === deck) { this.cancelFade(); return; }
        const loaded = this.current;
        if (!loaded || loaded.deck !== deck) return;
        const queue = this.snapshot.queue;
        if (queue.repeat === 'one') {
            loaded.reporter?.stop();
            loaded.reporter = this.createReporter(loaded);
            loaded.startedAtMs = Date.now();
            deck.currentTime = 0;
            void deck.play().catch(error => this.playRejected(error));
            return;
        }
        const moved = advance(queue);
        if (moved) { this.go(moved.queue, moved.item); return; }
        this.resumeAt = 0;
        this.retire(loaded);
        this.current = null;
        this.emit({ playing: false, suspended: true });
        setPlaybackState('paused');
        this.updateHostSession('pause');
    }

    private onError(deck: HTMLAudioElement): void {
        if (this.pending?.deck === deck) { this.discardPending(); return; }
        const loaded = this.current;
        if (!loaded || loaded.deck !== deck || !deck.getAttribute('src')) return;
        this.trackFailed(loaded.item, t('The stream could not be decoded.'), true);
    }

    private trackFailed(item: MediaItem, reason: string, failed = false): void {
        this.failures++;
        const loaded = this.current;
        if (loaded) {
            loaded.reporter?.stop(failed);
            this.retire(loaded);
            this.current = null;
        }
        if (this.failures >= MAX_TRACK_FAILURES) {
            this.failures = 0;
            this.emit({ loading: false, playing: false, suspended: true, notice: t('Music stopped after repeated playback errors. {0}', reason) });
            this.clearMediaSession();
            return;
        }
        const notice = t('Skipped “{0}”: {1}', item.Name, reason);
        const moved = advance(this.snapshot.queue, true);
        if (moved) {
            void this.startItem(moved.queue, moved.item, 0).then(() => { if (this.snapshot.notice === '') this.emit({ notice }); });
            this.emit({ notice });
        } else {
            this.emit({ loading: false, playing: false, suspended: true, notice });
        }
    }

    private onPlaying(deck: HTMLAudioElement): void {
        const loaded = this.current;
        if (!loaded || loaded.deck !== deck) return;
        this.failures = 0;
        if (loaded.reporter && !loaded.reporter.isStarted) loaded.reporter.start();
        else loaded.reporter?.pulse();
        this.emit({ playing: true, suspended: false });
        setPlaybackState('playing');
        this.updateHostSession('playing');
    }

    private onPause(deck: HTMLAudioElement): void {
        const loaded = this.current;
        if (!loaded || loaded.deck !== deck || deck.ended) return;
        loaded.reporter?.pulse();
        this.emit({ playing: false });
        setPlaybackState('paused');
        this.updateHostSession('pause');
    }

    private playRejected(error: unknown): void {
        const name = (error as { name?: string } | null)?.name;
        if (name === 'AbortError') return;
        this.emit({ playing: false, notice: name === 'NotAllowedError' ? t('Press play to start the music.') : userMessage(error) });
    }

    private retire(loaded: Loaded): void {
        loaded.reporter?.stop();
        const deck = loaded.deck;
        deck.pause();
        deck.removeAttribute('src');
        try { deck.load(); } catch (_error) { /* Detached elements may refuse; the source is already gone. */ }
        if (loaded.choice.method !== 'DirectPlay') void this.api?.releasePlayback(loaded.choice).catch(() => undefined);
    }

    private applyVolume(loaded: Loaded, envelope: number): void {
        loaded.envelope = envelope;
        if (!this.volumeControl) return;
        const db = normalizationDb(loaded.item, loaded.item.AlbumId ? this.gains[loaded.item.AlbumId] : undefined, this.settings.normalization);
        loaded.deck.volume = elementVolume(this.settings.volume, db, envelope);
    }

    private reapplyVolumes(): void {
        [ this.current, this.pending, this.fade?.from ].forEach(loaded => { if (loaded) this.applyVolume(loaded, loaded.envelope); });
    }

    private loadGains(items: MediaItem[]): void {
        if (this.settings.normalization !== 'album' || !this.api) return;
        const missing = Array.from(new Set(items.map(item => item.AlbumId || '').filter(id => id && !(id in this.gains))));
        if (!missing.length) return;
        missing.forEach(id => { this.gains[id] = Number.NaN; });
        void this.api.getNormalizationGains(missing).then(gains => {
            Object.assign(this.gains, gains);
            this.reapplyVolumes();
        }).catch(() => undefined);
    }

    private bindMediaSession(): void {
        const session = mediaSession();
        if (!session) return;
        const handle = (action: string, handler: (details: { seekTime?: number; seekOffset?: number }) => void) => {
            try { session.setActionHandler(action, handler); } catch (_error) { /* Unsupported action. */ }
        };
        handle('play', () => { if (this.current?.deck.paused) this.toggle(); });
        handle('pause', () => { if (this.current && !this.current.deck.paused) this.toggle(); });
        handle('previoustrack', () => { if (this.current) this.previous(); });
        handle('nexttrack', () => { if (this.current) this.next(); });
        handle('seekto', details => { if (this.current && typeof details.seekTime === 'number') this.seek(details.seekTime); });
        handle('seekbackward', details => { if (this.current) this.seek(this.positionOf(this.current) - (details.seekOffset || 10)); });
        handle('seekforward', details => { if (this.current) this.seek(this.positionOf(this.current) + (details.seekOffset || 10)); });
    }

    private updateMediaSession(action: string): void {
        const item = this.snapshot.current;
        const session = mediaSession();
        const Metadata = (globalThis as unknown as { MediaMetadata?: new (init: unknown) => unknown }).MediaMetadata;
        if (session && Metadata && item) {
            try { session.metadata = new Metadata(mediaSessionMetadata(item, trackImageUrl(this.api, item, 512) || undefined)); } catch (_error) { /* Metadata is cosmetic. */ }
        }
        this.updateHostSession(action);
    }

    private updateHostSession(action: string): void {
        const loaded = this.current;
        if (!loaded || !hasNativeShell()) return;
        this.lastHostUpdate = Date.now();
        updateHostMediaSession(hostMediaSessionInfo(loaded.item, {
            action,
            positionSeconds: this.positionOf(loaded),
            durationSeconds: this.durationOf(loaded),
            paused: loaded.deck.paused,
            imageUrl: trackImageUrl(this.api, loaded.item, 600) || undefined,
        }));
    }

    private clearMediaSession(): void {
        const session = mediaSession();
        if (session) {
            [ 'play', 'pause', 'previoustrack', 'nexttrack', 'seekto', 'seekbackward', 'seekforward' ].forEach(action => {
                try { session.setActionHandler(action, null); } catch (_error) { /* Unsupported action. */ }
            });
            try { session.metadata = null; session.playbackState = 'none'; } catch (_error) { /* Cosmetic. */ }
        }
        if (hasNativeShell()) hideHostMediaSession();
    }
}

interface MediaSessionLike {
    metadata: unknown;
    playbackState: string;
    setActionHandler(action: string, handler: ((details: { seekTime?: number; seekOffset?: number }) => void) | null): void;
    setPositionState?: (state: { duration: number; position: number; playbackRate: number }) => void;
}

function mediaSession(): MediaSessionLike | null {
    return typeof navigator !== 'undefined' ? (navigator as unknown as { mediaSession?: MediaSessionLike }).mediaSession || null : null;
}

function setPlaybackState(state: 'playing' | 'paused'): void {
    const session = mediaSession();
    if (session) try { session.playbackState = state; } catch (_error) { /* Cosmetic. */ }
}

function setPositionState(state: { duration: number; position: number; playbackRate: number } | null): void {
    const session = mediaSession();
    if (session?.setPositionState && state) try { session.setPositionState(state); } catch (_error) { /* Invalid states are dropped. */ }
}

/** iOS keeps `volume` at 1 whatever is written, so normalization and crossfade are unavailable there. */
function detectVolumeControl(deck: HTMLAudioElement): boolean {
    try {
        deck.volume = 0.5;
        const works = Math.abs(deck.volume - 0.5) < 0.01;
        deck.volume = 1;
        return works;
    } catch (_error) {
        return false;
    }
}

export const musicEngine = new MusicEngine();

/** Structural state (queue, current track, play state) for the app shell. */
export function useMusicPlayer(api: JellyfinApi | null): MusicSnapshot {
    const [ snapshot, setSnapshot ] = useState(musicEngine.snapshot);
    useEffect(() => musicEngine.subscribe(setSnapshot), []);
    useEffect(() => { musicEngine.attach(api); }, [ api ]);
    return snapshot;
}

/** Position updates only re-render the component that shows them. */
function useMusicPosition(): MusicPosition {
    const [ position, setPosition ] = useState(() => musicEngine.position());
    useEffect(() => {
        let frame = 0;
        const unsubscribe = musicEngine.subscribePosition(() => {
            if (frame) return;
            frame = window.setTimeout(() => { frame = 0; setPosition(musicEngine.position()); }, 250);
        });
        return () => { unsubscribe(); window.clearTimeout(frame); };
    }, []);
    return position;
}

function PlayIcon({ playing }: { playing: boolean }) {
    return playing
        ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3v14H7zM14 5h3v14h-3z" fill="currentColor" /></svg>
        : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor" /></svg>;
}

function SkipIcon({ forward }: { forward: boolean }) {
    return <svg viewBox="0 0 24 24" aria-hidden="true" class="dir-arrow">{forward
        ? <path d="M6 6l9 6-9 6zM16 6h2v12h-2z" fill="currentColor" />
        : <path d="M18 6l-9 6 9 6zM6 6h2v12H6z" fill="currentColor" />}</svg>;
}

export function MiniPlayer({ snapshot, api, onExpand }: { snapshot: MusicSnapshot; api: JellyfinApi | null; onExpand: () => void }) {
    const { position, duration } = useMusicPosition();
    const item = snapshot.current;
    if (!item) return null;
    const art = trackImageUrl(api, item, 120);
    const percent = duration > 0 ? Math.min(100, position / duration * 100) : 0;
    const playLabel = snapshot.playing ? t('Pause') : t('Play');
    return <section class="music-mini" aria-label={t('Music player')} data-focusable="scope">
        <div class="music-mini-progress" aria-hidden="true"><span style={{ width: `${percent}%` }} /></div>
        <button class="music-mini-track" data-focusable="true" type="button" onClick={onExpand} aria-label={t('Open Now Playing: {0}', item.Name)}>
            {art ? <img src={art} alt="" /> : <span class="music-art-fallback" aria-hidden="true">♪</span>}
            <span><strong>{item.Name}</strong><small>{trackArtist(item)}</small></span>
        </button>
        {snapshot.notice && <p class="music-mini-notice" role="status">{snapshot.notice}</p>}
        <div class="music-mini-controls">
            <button data-focusable="true" type="button" aria-label={t('Previous track')} onClick={() => musicEngine.previous()}><SkipIcon forward={false} /></button>
            <button data-focusable="true" type="button" class="music-play" aria-label={playLabel} disabled={snapshot.loading} onClick={() => musicEngine.toggle()}><PlayIcon playing={snapshot.playing} /></button>
            <button data-focusable="true" type="button" aria-label={t('Next track')} onClick={() => musicEngine.next()}><SkipIcon forward /></button>
        </div>
    </section>;
}

export function NowPlaying({ snapshot, api, tvClient, onBack }: { snapshot: MusicSnapshot; api: JellyfinApi | null; tvClient: boolean; onBack: () => void }) {
    const { position, duration } = useMusicPosition();
    const [ seeking, setSeeking ] = useState<number | null>(null);
    const listRef = useRef<HTMLOListElement>(null);
    const item = snapshot.current;
    const queue = snapshot.queue;
    useEffect(() => {
        const list = listRef.current;
        const row = list?.querySelector<HTMLElement>('.music-queue-row.current');
        if (!list || !row || list.scrollHeight <= list.clientHeight) return;
        list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top - list.clientHeight / 3;
    }, [ item?.Id ]);
    const repeatLabel = queue.repeat === 'one' ? t('Repeat one') : queue.repeat === 'all' ? t('Repeat all') : t('Repeat off');
    const shown = seeking ?? position;
    return <div class="now-playing">
        <button class="back-link" data-focusable="true" type="button" onClick={onBack}><span class="dir-arrow" aria-hidden="true">←</span> <span>{t('Back')}</span></button>
        {!item ? <section class="now-playing-empty">
            <h1>{t('Now Playing')}</h1>
            <p>{t('Nothing is playing. Play an album, artist, playlist or song to start the music queue.')}</p>
        </section> : <div class="now-playing-layout">
            <section class="now-playing-main" aria-label={t('Now Playing')}>
                {trackImageUrl(api, item, 900) ? <img class="now-playing-art" src={trackImageUrl(api, item, 900)} alt="" /> : <div class="now-playing-art music-art-fallback" aria-hidden="true">♪</div>}
                <p class="eyebrow">{t('Now Playing')}</p>
                <h1>{item.Name}</h1>
                <p class="now-playing-meta">{[ trackArtist(item), item.Album ].filter(Boolean).join(' · ')}</p>
                {snapshot.notice && <p class="notice error" role="status">{snapshot.notice}<button type="button" aria-label={t('Dismiss')} onClick={() => musicEngine.dismissNotice()}>×</button></p>}
                <div class="now-playing-seek">
                    <span>{formatDuration(shown)}</span>
                    <input data-focusable="true" type="range" min={0} max={Math.max(1, Math.round(duration))} step={1} value={Math.round(shown)} aria-label={t('Seek')}
                        onInput={event => setSeeking(Number((event.currentTarget as HTMLInputElement).value))}
                        onChange={event => { musicEngine.seek(Number((event.currentTarget as HTMLInputElement).value)); setSeeking(null); }} />
                    <span>{formatDuration(duration)}</span>
                </div>
                <div class="now-playing-controls">
                    <button data-focusable="true" type="button" aria-label={t('Shuffle')} aria-pressed={queue.shuffle} class={queue.shuffle ? 'active' : ''} onClick={() => musicEngine.toggleShuffle()}>
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h3l10 10h3M4 17h3l3-3M14 10l3-3h3M18 4l3 3-3 3M18 14l3 3-3 3" fill="none" stroke="currentColor" stroke-width="2" /></svg>
                    </button>
                    <button data-focusable="true" type="button" aria-label={t('Previous track')} onClick={() => musicEngine.previous()}><SkipIcon forward={false} /></button>
                    <button data-focusable="true" type="button" class="music-play" aria-label={snapshot.playing ? t('Pause') : t('Play')} disabled={snapshot.loading} onClick={() => musicEngine.toggle()}><PlayIcon playing={snapshot.playing} /></button>
                    <button data-focusable="true" type="button" aria-label={t('Next track')} onClick={() => musicEngine.next()}><SkipIcon forward /></button>
                    <button data-focusable="true" type="button" aria-label={repeatLabel} aria-pressed={queue.repeat !== 'off'} class={queue.repeat !== 'off' ? 'active' : ''} onClick={() => musicEngine.cycleRepeat()}>
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 10V8h12l-3-3M19 14v2H7l3 3" fill="none" stroke="currentColor" stroke-width="2" /></svg>
                        {queue.repeat === 'one' && <span class="music-repeat-one">1</span>}
                    </button>
                </div>
                {snapshot.volumeControl && !tvClient && <label class="now-playing-volume">{t('Volume')}
                    <input data-focusable="true" type="range" min={0} max={100} step={1} value={Math.round(snapshot.volume * 100)} onInput={event => musicEngine.setVolume(Number((event.currentTarget as HTMLInputElement).value) / 100)} />
                </label>}
            </section>
            <section class="now-playing-queue" aria-labelledby="music-queue-title">
                <div class="now-playing-queue-heading">
                    <h2 id="music-queue-title">{t('Queue')} <small>{t('{0} tracks', queue.order.length)}</small></h2>
                    <button data-focusable="true" type="button" class="button secondary" onClick={() => { musicEngine.stop(); onBack(); }}>{t('Clear queue')}</button>
                </div>
                <ol ref={listRef} class="music-queue">{queue.order.map((entry, index) => {
                    const isCurrent = index === queue.position && queue.active;
                    return <li key={`${entry.Id}-${index}`} class={`music-queue-row${isCurrent ? ' current' : ''}`}>
                        <button data-focusable="true" type="button" class="music-queue-open" aria-current={isCurrent ? 'true' : undefined} onClick={() => musicEngine.jump(index)}>
                            <span class="music-queue-index">{index + 1}</span>
                            <span><strong>{entry.Name}</strong><small>{trackArtist(entry)}</small></span>
                            <span class="music-queue-time">{formatDuration(ticksToSeconds(entry.RunTimeTicks))}</span>
                        </button>
                        <button data-focusable="true" type="button" aria-label={t('Move “{0}” up', entry.Name)} disabled={index === 0} onClick={() => musicEngine.move(index, -1)}>↑</button>
                        <button data-focusable="true" type="button" aria-label={t('Move “{0}” down', entry.Name)} disabled={index === queue.order.length - 1} onClick={() => musicEngine.move(index, 1)}>↓</button>
                        <button data-focusable="true" type="button" aria-label={t('Remove “{0}” from the queue', entry.Name)} disabled={isCurrent} onClick={() => musicEngine.remove(index)}>×</button>
                    </li>;
                })}</ol>
            </section>
        </div>}
    </div>;
}

/** Detail-page actions for a track, album, artist or music genre. */
export function MusicActions({ item, playRef }: { item: MediaItem; playRef?: Ref<HTMLButtonElement> }) {
    const track = isAudioItem(item);
    return <>
        <button ref={playRef} data-focusable="true" class="button primary" type="button" onClick={() => void musicEngine.playItem(item)}>▶ <span>{t('Play')}</span></button>
        {!track && <button data-focusable="true" class="button secondary" type="button" onClick={() => void musicEngine.playItem(item, { shuffle: true })}>{t('⤮ Shuffle')}</button>}
        <button data-focusable="true" class="button secondary" type="button" onClick={() => void musicEngine.instantMix(item)}>{t('Instant Mix')}</button>
        <button data-focusable="true" class="button secondary" type="button" onClick={() => void musicEngine.playNext(item)}>{t('Play next')}</button>
        <button data-focusable="true" class="button secondary" type="button" onClick={() => void musicEngine.addToQueue(item)}>{t('Add to queue')}</button>
    </>;
}
