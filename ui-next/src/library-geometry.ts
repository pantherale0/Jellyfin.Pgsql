/** Library row geometry shared with style.css through `--library-list-row` and `--library-poster-ratio`. */
export function libraryGeometry(style: Pick<CSSStyleDeclaration, 'getPropertyValue'>): { listRow: number; posterRatio: number } {
    const listRow = parseFloat(style.getPropertyValue('--library-list-row'));
    const posterRatio = parseFloat(style.getPropertyValue('--library-poster-ratio'));
    return {
        listRow: Number.isFinite(listRow) && listRow > 0 ? listRow : 92,
        posterRatio: Number.isFinite(posterRatio) && posterRatio > 0 ? posterRatio : 1.5
    };
}
