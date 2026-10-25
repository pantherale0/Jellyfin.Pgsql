import type { AccountGeneration } from './account-generation';

export interface NavigationIntent { readonly id: number; readonly account: number }

/**
 * Owns slow navigation (playback negotiation, Season-to-Series lookups, deep-link restores).
 * Starting an intent or making any other route choice retires older ones, and an intent only
 * commits while both it and the signed-in account that started it are still current.
 */
export class NavigationOwner {
    private value = 0;
    private readonly account: AccountGeneration;

    constructor(account: AccountGeneration) {
        this.account = account;
    }

    begin(): NavigationIntent {
        this.value += 1;
        return { id: this.value, account: this.account.current() };
    }

    retire(): void {
        this.value += 1;
    }

    isCurrent(intent: NavigationIntent): boolean {
        return intent.id === this.value && this.account.isCurrent(intent.account);
    }
}
