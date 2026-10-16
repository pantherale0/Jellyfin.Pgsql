import { t } from './i18n';
export interface CaptionStyle {
    size: 'small' | 'normal' | 'large' | 'xlarge';
    font: 'sans' | 'serif' | 'mono' | 'casual';
    weight: 'normal' | 'bold';
    color: 'white' | 'yellow' | 'cyan' | 'green';
    edge: 'shadow' | 'outline' | 'box' | 'none';
    /** Lines up from the bottom of the picture (0 = the browser's default placement). */
    position: number;
}

export const CAPTION_STYLE_KEY = 'ui-next-caption-style';
export const DEFAULT_CAPTION_STYLE: CaptionStyle = { size: 'normal', font: 'sans', weight: 'normal', color: 'white', edge: 'shadow', position: 0 };

export const CAPTION_CHOICES = {
    size: [ [ 'small', 'Small' ], [ 'normal', 'Normal' ], [ 'large', 'Large' ], [ 'xlarge', 'Extra large' ] ],
    font: [ [ 'sans', 'Sans-serif' ], [ 'serif', 'Serif' ], [ 'mono', 'Monospace' ], [ 'casual', 'Casual' ] ],
    weight: [ [ 'normal', 'Normal' ], [ 'bold', 'Bold' ] ],
    color: [ [ 'white', 'White' ], [ 'yellow', 'Yellow' ], [ 'cyan', 'Cyan' ], [ 'green', 'Green' ] ],
    edge: [ [ 'shadow', 'Drop shadow' ], [ 'outline', 'Outline' ], [ 'box', 'Background box' ], [ 'none', 'None' ] ],
} as const;

const SIZES = { small: '1.6vw', normal: '2.2vw', large: '2.9vw', xlarge: '3.6vw' };
const FONTS = { sans: 'system-ui, "Segoe UI", Roboto, Arial, sans-serif', serif: t('Georgia, "Times New Roman", serif'), mono: '"DejaVu Sans Mono", Menlo, Consolas, monospace', casual: '"Comic Neue", "Comic Sans MS", "Trebuchet MS", sans-serif' };
const COLORS = { white: '#ffffff', yellow: '#ffe14d', cyan: '#6ff3ff', green: '#9bf07a' };
const EDGES = {
    shadow: { shadow: '0 2px 4px rgba(0,0,0,.95), 0 0 2px #000', background: 'transparent' },
    outline: { shadow: '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 0 3px #000', background: 'transparent' },
    box: { shadow: 'none', background: 'rgba(0,0,0,.78)' },
    none: { shadow: 'none', background: 'transparent' },
};

function pick<T extends string>(value: unknown, allowed: readonly (readonly [T, string])[], fallback: T): T {
    return allowed.some(([ key ]) => key === value) ? value as T : fallback;
}

export function normalizeCaptionStyle(raw: unknown): CaptionStyle {
    const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const position = typeof value.position === 'number' && Number.isFinite(value.position) ? Math.round(Math.min(8, Math.max(0, value.position))) : 0;
    return {
        size: pick(value.size, CAPTION_CHOICES.size, 'normal'),
        font: pick(value.font, CAPTION_CHOICES.font, 'sans'),
        weight: pick(value.weight, CAPTION_CHOICES.weight, 'normal'),
        color: pick(value.color, CAPTION_CHOICES.color, 'white'),
        edge: pick(value.edge, CAPTION_CHOICES.edge, 'shadow'),
        position,
    };
}

export function loadCaptionStyle(): CaptionStyle {
    try {
        return normalizeCaptionStyle(JSON.parse(localStorage.getItem(CAPTION_STYLE_KEY) || '{}'));
    } catch (_error) {
        return { ...DEFAULT_CAPTION_STYLE };
    }
}

export function saveCaptionStyle(change: Partial<CaptionStyle>): CaptionStyle {
    const next = normalizeCaptionStyle({ ...loadCaptionStyle(), ...change });
    try { localStorage.setItem(CAPTION_STYLE_KEY, JSON.stringify(next)); } catch (_error) { /* Private mode keeps the in-memory value. */ }
    return next;
}

export function captionDeclarations(style: CaptionStyle): string {
    const edge = EDGES[style.edge];
    return `color: ${COLORS[style.color]}; background: ${edge.background}; text-shadow: ${edge.shadow}; font-family: ${FONTS[style.font]}; font-weight: ${style.weight === 'bold' ? 700 : 400}; font-size: ${SIZES[style.size]};`;
}

/** Stylesheet for browser-rendered (WebVTT) captions and the settings preview. */
export function captionCss(style: CaptionStyle, scope = '.player-video'): string {
    const declarations = captionDeclarations(style);
    return `${scope}::cue { ${declarations} line-height: 1.25; }\n.caption-preview-text { ${declarations.replace(/font-size: [^;]+;/, 'font-size: clamp(14px, 2.2vw, 28px);')} }`;
}

/** VTT `line` for primary captions (negative counts lines up from the bottom), or 'auto'. */
export function primaryCueLine(style: CaptionStyle): number | 'auto' {
    return style.position > 0 ? -1 - style.position : 'auto';
}

export const SECONDARY_TRACK_LABEL = t('Secondary subtitles');
