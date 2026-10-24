export interface FieldDef { key: string; type: 'string' | 'number' | 'bool' | 'secret' }

export function labelify(key: string): string {
    return key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).replace(/\./g, ' · ');
}

export function inferFields(obj: Record<string, any>): FieldDef[] {
    return Object.entries(obj)
        .filter(([, v]) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
        .map(([key, value]) => ({
            key,
            type: typeof value === 'boolean'
                ? 'bool'
                : /password|passwd|token|secret|api_?key|private_?key|connectionstring|credential/i.test(key) ? 'secret' : typeof value as 'string' | 'number',
        }));
}
