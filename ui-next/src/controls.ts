export type SmoothScrollChoice = 'auto' | 'on' | 'off';
export interface ControlPreferences { gamepad: boolean; smoothScroll: SmoothScrollChoice }

const STORAGE_KEY = 'ui-next-controls';
export const DEFAULT_CONTROLS: ControlPreferences = { gamepad: true, smoothScroll: 'auto' };

export function normalizeControls(raw: unknown): ControlPreferences {
    const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    return {
        gamepad: typeof value.gamepad === 'boolean' ? value.gamepad : DEFAULT_CONTROLS.gamepad,
        smoothScroll: value.smoothScroll === 'on' || value.smoothScroll === 'off' ? value.smoothScroll : 'auto',
    };
}

export function loadControlPreferences(): ControlPreferences {
    try {
        return normalizeControls(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'));
    } catch (_error) {
        return DEFAULT_CONTROLS;
    }
}

export function saveControlPreferences(change: Partial<ControlPreferences>): ControlPreferences {
    const next = normalizeControls({ ...loadControlPreferences(), ...change });
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (_error) { /* Private browsing: the preference applies to this page only. */ }
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
        window.dispatchEvent(new CustomEvent('ui-next-controls', { detail: next }));
    }
    return next;
}

/** Standard-mapping gamepad: D-pad 12–15 and the left stick navigate, A selects, B goes back. */
export function gamepadDirections(buttons: ReadonlyArray<{ pressed: boolean }>, axes: ReadonlyArray<number>): string[] {
    const pressed = (index: number) => buttons[index]?.pressed === true;
    const keys: string[] = [];
    if (pressed(12) || (axes[1] ?? 0) < -0.5) keys.push('ArrowUp');
    if (pressed(13) || (axes[1] ?? 0) > 0.5) keys.push('ArrowDown');
    if (pressed(14) || (axes[0] ?? 0) < -0.5) keys.push('ArrowLeft');
    if (pressed(15) || (axes[0] ?? 0) > 0.5) keys.push('ArrowRight');
    if (pressed(0)) keys.push('Enter');
    if (pressed(1)) keys.push('Escape');
    return keys;
}

export const GAMEPAD_REPEAT_DELAY_MS = 450;
export const GAMEPAD_REPEAT_INTERVAL_MS = 130;

/** Keys to emit this frame: first press immediately, directions then repeat while held. */
export function gamepadKeysToEmit(held: Map<string, number>, active: string[], now: number): string[] {
    const emit: string[] = [];
    held.forEach((_, key) => { if (!active.includes(key)) held.delete(key); });
    active.forEach(key => {
        const next = held.get(key);
        if (next === undefined) {
            emit.push(key);
            held.set(key, now + GAMEPAD_REPEAT_DELAY_MS);
        } else if (key.startsWith('Arrow') && now >= next) {
            emit.push(key);
            held.set(key, now + GAMEPAD_REPEAT_INTERVAL_MS);
        }
    });
    return emit;
}

/** Translates gamepad input into the keyboard events the remote navigation already handles. */
export function startGamepadBridge(): () => void {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function' || typeof requestAnimationFrame !== 'function') return () => undefined;
    const held = new Map<string, number>();
    let frame = 0;
    const emit = (key: string) => {
        const target = (document.activeElement as HTMLElement | null) || document.body;
        const keyCode = ({ ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Enter: 13, Escape: 27 } as Record<string, number>)[key];
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        Object.defineProperty(event, 'keyCode', { get: () => keyCode });
        const proceed = target.dispatchEvent(event);
        if (key === 'Enter' && proceed && target !== document.body) target.click();
    };
    const connected = () => Array.from(navigator.getGamepads() || []).filter((pad): pad is Gamepad => !!pad && pad.connected);
    const poll = () => {
        const pads = connected();
        if (!pads.length) { frame = 0; held.clear(); return; }
        const active = [ ...new Set(pads.flatMap(pad => gamepadDirections(pad.buttons, pad.axes))) ];
        gamepadKeysToEmit(held, active, performance.now()).forEach(emit);
        frame = requestAnimationFrame(poll);
    };
    const start = () => { if (!frame) frame = requestAnimationFrame(poll); };
    window.addEventListener('gamepadconnected', start);
    if (connected().length) start();
    return () => {
        window.removeEventListener('gamepadconnected', start);
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
    };
}
