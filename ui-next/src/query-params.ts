function safeDecode(value: string): string {
    try {
        return decodeURIComponent(value.replace(/\+/g, ' '));
    } catch (_error) {
        return value;
    }
}

export function queryParameter(search: string, name: string): string | null {
    const parts = search.replace(/^\?/, '').split('&');
    for (let i = 0; i < parts.length; i++) {
        const pair = parts[i].split('=');
        if (safeDecode(pair[0]) === name) {
            return safeDecode(pair.slice(1).join('=') || '');
        }
    }
    return null;
}
