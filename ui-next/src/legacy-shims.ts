/**
 * DOM shims for the legacy targets in vite.config.ts. core-js (usage-detected by plugin-legacy)
 * only covers ECMAScript built-ins and URL/URLSearchParams; these DOM APIs are used unguarded.
 * ResizeObserver/IntersectionObserver are feature-detected at their call sites instead.
 */

type Listener = (event: { type: 'abort' }) => void;

class AbortSignalShim {
    aborted = false;
    onabort: Listener | null = null;
    private listeners: Listener[] = [];

    addEventListener(type: string, listener: Listener): void {
        if (type === 'abort' && this.listeners.indexOf(listener) < 0) this.listeners.push(listener);
    }

    removeEventListener(type: string, listener: Listener): void {
        if (type === 'abort') this.listeners = this.listeners.filter(current => current !== listener);
    }

    dispatch(): void {
        if (this.aborted) return;
        this.aborted = true;
        const event = { type: 'abort' as const };
        const listeners = this.listeners.slice();
        this.listeners = [];
        this.onabort?.(event);
        listeners.forEach(listener => listener(event));
    }
}

export class AbortControllerShim {
    readonly signal = new AbortSignalShim();

    abort(): void {
        this.signal.dispatch();
    }
}

export function installLegacyShims(scope: Record<string, unknown>, elementProto?: Partial<Element> & Record<string, unknown>): void {
    if (typeof scope.AbortController !== 'function') scope.AbortController = AbortControllerShim;
    if (!elementProto) return;
    if (typeof elementProto.matches !== 'function') {
        elementProto.matches = (elementProto.webkitMatchesSelector || elementProto.msMatchesSelector) as Element['matches'];
    }
    if (typeof elementProto.closest !== 'function') {
        elementProto.closest = function closest(this: Element, selector: string): Element | null {
            let node: Element | null = this;
            while (node) {
                if (node.matches(selector)) return node;
                node = node.parentElement;
            }
            return null;
        } as Element['closest'];
    }
}

if (typeof window !== 'undefined') {
    installLegacyShims(window as unknown as Record<string, unknown>, typeof Element !== 'undefined' ? Element.prototype as unknown as Partial<Element> & Record<string, unknown> : undefined);
}
