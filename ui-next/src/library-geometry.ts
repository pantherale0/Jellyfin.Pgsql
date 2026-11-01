/** Library dimensions shared with CSS, including the TV caption below the artwork. */
export function libraryGeometry(style: Pick<CSSStyleDeclaration, 'getPropertyValue'>): { listRow: number; posterRatio: number } {
    const listRow = parseFloat(style.getPropertyValue('--library-list-row'));
    const posterRatio = parseFloat(style.getPropertyValue('--library-poster-ratio'));
    return {
        listRow: Number.isFinite(listRow) && listRow > 0 ? listRow : 92,
        posterRatio: Number.isFinite(posterRatio) && posterRatio > 0 ? posterRatio : 1.5
    };
}

export function libraryCaptionHeight(style: Pick<CSSStyleDeclaration, 'getPropertyValue'>): number {
    const height = parseFloat(style.getPropertyValue('--library-caption-height'));
    return Number.isFinite(height) && height > 0 ? height : 0;
}

/** Older webOS can retain repeat()/minmax() instead of resolving tracks to pixels. */
export function libraryColumnCount(style: Pick<CSSStyleDeclaration, 'getPropertyValue' | 'gridTemplateColumns'>): number {
    const explicit = Number(style.getPropertyValue('--tv-library-columns'));
    if (Number.isInteger(explicit) && explicit > 0) return explicit;
    const template = style.gridTemplateColumns.trim();
    const repeat = /^repeat\(\s*(\d+)\s*,/.exec(template);
    if (repeat) return Math.max(1, Number(repeat[1]));
    if (!template || template === 'none') return 1;
    let depth = 0;
    let brackets = 0;
    let tracks = 0;
    let inTrack = false;
    for (const character of template) {
        if (character === '[') brackets++;
        if (character === ']') { brackets--; continue; }
        if (brackets) continue;
        if (/\s/.test(character) && depth === 0) { inTrack = false; continue; }
        if (!inTrack) { tracks++; inTrack = true; }
        if (character === '(') depth++;
        if (character === ')') depth--;
    }
    return Math.max(1, tracks);
}
