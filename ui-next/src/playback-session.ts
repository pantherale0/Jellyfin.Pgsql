import type { AccountGeneration } from './account-generation';
import type { NavigationOwner } from './navigation-owner';

export interface PlaybackSessionSnapshot {
    key: number;
    itemId: string;
    mediaSourceId?: string;
    playSessionId?: string;
    liveStreamId?: string;
    account: number;
    navigation: number;
}

export interface PlaybackSessionMedia {
    mediaSourceId?: string;
    playSessionId?: string;
    liveStreamId?: string;
}

interface LiveLease { id: string; released: boolean; cleanupClaimed: boolean }

/**
 * Owns one logical playback session across App negotiation, Player reporting,
 * and live-stream cleanup. Starting, replacing, leaving, or changing accounts
 * retires older sessions; only the current session may commit a new stream or
 * claim live-stream cleanup.
 */
export class PlaybackSessionTracker {
    private sequence = 0;
    private current: PlaybackSessionSnapshot | null = null;
    private pending: PlaybackSessionSnapshot | null = null;
    private leases = new WeakMap<PlaybackSessionSnapshot, LiveLease>();

    private readonly account: AccountGeneration;
    private readonly navigation: NavigationOwner;

    constructor(account: AccountGeneration, navigation: NavigationOwner) {
        this.account = account;
        this.navigation = navigation;
    }

    begin(itemId: string): PlaybackSessionSnapshot {
        this.sequence += 1;
        const intent = this.navigation.begin();
        this.pending = {
            key: this.sequence,
            itemId,
            account: this.account.current(),
            navigation: intent.id
        };
        return this.pending;
    }

    commit(snapshot: PlaybackSessionSnapshot, media: PlaybackSessionMedia, retainedLiveStreamId?: string): PlaybackSessionSnapshot | null {
        if (this.pending !== snapshot || !this.isCurrent(snapshot)) return null;
        const previousLease = this.current ? this.leases.get(this.current) : undefined;
        this.current = Object.freeze({
            ...snapshot,
            mediaSourceId: media.mediaSourceId,
            playSessionId: media.playSessionId,
            liveStreamId: media.liveStreamId
        });
        if (media.liveStreamId) {
            const lease = previousLease && !previousLease.released && retainedLiveStreamId === previousLease.id && media.liveStreamId === previousLease.id
                ? previousLease : { id: media.liveStreamId, released: false, cleanupClaimed: false };
            this.leases.set(this.current, lease);
        }
        this.pending = null;
        return this.current;
    }

    retire(snapshot?: PlaybackSessionSnapshot | null): void {
        if (!snapshot || this.current === snapshot) this.current = null;
        if (!snapshot || this.pending === snapshot) this.pending = null;
    }

    active(): PlaybackSessionSnapshot | null {
        return this.current;
    }

    isCurrent(snapshot: PlaybackSessionSnapshot | null | undefined): boolean {
        if (!snapshot || !this.account.isCurrent(snapshot.account)) return false;
        if (this.current?.key === snapshot.key) return true;
        return this.pending === snapshot && this.navigation.isCurrent({ id: snapshot.navigation, account: snapshot.account });
    }

    canRefresh(snapshot: PlaybackSessionSnapshot): boolean {
        return this.account.isCurrent(snapshot.account);
    }

    retainsLiveStream(snapshot: PlaybackSessionSnapshot): boolean {
        return this.current !== snapshot && this.current !== null && this.leases.has(snapshot)
            && this.leases.get(this.current) === this.leases.get(snapshot)
            && this.isCurrent(this.current);
    }

    liveStreamFor(snapshot: PlaybackSessionSnapshot): string | undefined {
        const lease = this.leases.get(snapshot);
        return lease && !lease.released ? lease.id : undefined;
    }

    markLiveReleased(snapshot: PlaybackSessionSnapshot): void {
        const lease = this.leases.get(snapshot);
        if (lease) lease.released = true;
    }

    claimLiveCleanup(snapshot: PlaybackSessionSnapshot): boolean {
        const lease = this.leases.get(snapshot);
        if (!lease || lease.released || lease.cleanupClaimed) return false;
        if (this.current !== snapshot && this.current?.liveStreamId === lease.id && this.isCurrent(this.current)) return false;
        lease.cleanupClaimed = true;
        return true;
    }
}
