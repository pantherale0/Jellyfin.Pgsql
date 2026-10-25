import { useEffect, useRef } from 'preact/hooks';
import type { RefObject } from 'preact';

export const TABBABLE_SELECTOR = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

export function isBackKey(event: Pick<KeyboardEvent, 'key' | 'keyCode'>): boolean {
    return event.key === 'Escape' || event.key === 'Back' || event.key === 'GoBack' || event.key === 'BrowserBack' || event.keyCode === 461 || event.keyCode === 10009;
}

/** Native controls that keep an arrow key for themselves; global D-pad movement must skip these. Selects keep Up/Down to change value, and Left/Right leave the control. */
export function nativeControlOwnsKey(target: { tagName?: string; type?: string } | null, key: string): boolean {
    const tag = target?.tagName?.toUpperCase();
    if (tag === 'SELECT') return key === 'ArrowUp' || key === 'ArrowDown';
    if (tag === 'TEXTAREA') return key.startsWith('Arrow');
    if (tag === 'INPUT') return target?.type === 'range' || key === 'ArrowLeft' || key === 'ArrowRight';
    return false;
}

export function tabbableWithin(root: ParentNode): HTMLElement[] {
    return Array.from(root.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR)).filter(element => element.getClientRects().length > 0);
}

/** The element Tab should land on to stay inside a dialog, or null when the browser's own move is already inside. */
export function wrapTabTarget<T>(controls: T[], active: T | null, backwards: boolean): T | null {
    if (!controls.length) return null;
    const index = active === null ? -1 : controls.indexOf(active);
    if (index < 0) return backwards ? controls[controls.length - 1] : controls[0];
    if (backwards && index === 0) return controls[controls.length - 1];
    if (!backwards && index === controls.length - 1) return controls[0];
    return null;
}

/** Marks every sibling along the path from the dialog to <body> inert, returning a restore function. Click-to-close backdrops opt out with data-dialog-backdrop. */
export function inertOutside(element: HTMLElement): () => void {
    const changed: HTMLElement[] = [];
    let node: HTMLElement | null = element;
    while (node && node !== document.body && node.parentElement) {
        for (const sibling of Array.from(node.parentElement.children)) {
            if (sibling === node || !(sibling instanceof HTMLElement) || sibling.hasAttribute('inert') || sibling.hasAttribute('data-dialog-backdrop') || sibling.tagName === 'SCRIPT') continue;
            sibling.setAttribute('inert', '');
            changed.push(sibling);
        }
        node = node.parentElement;
    }
    return () => changed.forEach(sibling => sibling.removeAttribute('inert'));
}

export interface DialogFocusOptions {
    /** Selector for the control that receives focus on open; defaults to the first tabbable control. */
    initial?: string;
    /** Make everything outside the dialog inert (modal). Defaults to true. */
    modal?: boolean;
    /** Element to restore focus to when the opener is gone. */
    fallback?: () => HTMLElement | null | undefined;
}

/**
 * Modal lifecycle shared by overlays: entry focus, Tab/Shift+Tab confinement,
 * Escape and remote Back close, background inertness and opener restoration.
 * D-pad arrow movement stays with each overlay.
 */
export function useDialogFocus(ref: RefObject<HTMLElement>, active: boolean, onClose: () => void, options: DialogFocusOptions = {}): void {
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;
    const optionsRef = useRef(options);
    optionsRef.current = options;
    useEffect(() => {
        const dialog = ref.current;
        if (!active || !dialog) return;
        const focused = document.activeElement;
        const opener = focused instanceof HTMLElement && focused !== document.body && !dialog.contains(focused) ? focused : null;
        const restoreInert = optionsRef.current.modal === false ? () => undefined : inertOutside(dialog);
        const initial = optionsRef.current.initial ? dialog.querySelector<HTMLElement>(optionsRef.current.initial) : null;
        if (!dialog.contains(document.activeElement)) (initial || tabbableWithin(dialog)[0] || dialog).focus();
        const onKeyDown = (event: KeyboardEvent) => {
            if (!dialog.isConnected) return;
            if (isBackKey(event)) {
                event.preventDefault();
                event.stopPropagation();
                onCloseRef.current();
                return;
            }
            if (event.key !== 'Tab') return;
            const target = wrapTabTarget(tabbableWithin(dialog), document.activeElement instanceof HTMLElement ? document.activeElement : null, event.shiftKey);
            if (target) {
                event.preventDefault();
                target.focus();
            }
        };
        document.addEventListener('keydown', onKeyDown, true);
        return () => {
            document.removeEventListener('keydown', onKeyDown, true);
            restoreInert();
            const restore = opener?.isConnected ? opener : optionsRef.current.fallback?.();
            if (restore) window.requestAnimationFrame(() => { if (restore.isConnected) restore.focus(); });
        };
    }, [ active ]);
}

/**
 * Tab out of the last mounted cell of a virtualized list (or Shift+Tab out of the first)
 * should continue to the next logical item instead of skipping every unmounted one.
 * Returns the item index to mount and focus, or null to let the browser move on.
 */
export function virtualTabTarget(index: number, mountedStart: number, mountedEnd: number, total: number, backwards: boolean): number | null {
    if (index < 0) return null;
    if (!backwards && index === mountedEnd - 1 && mountedEnd < total) return mountedEnd;
    if (backwards && index === mountedStart && mountedStart > 0) return mountedStart - 1;
    return null;
}
