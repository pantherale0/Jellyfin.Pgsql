import { readFileSync } from 'node:fs';

/**
 * Reads a source file with `t(...)` message wrappers undone, so wiring assertions written
 * against English literals keep working: `{t('Save')}` → `Save`, `aria-label={t('Close')}` →
 * `aria-label="Close"`, `t('{0} left', n)` → `` `${n} left` ``. Translation coverage has its
 * own test (i18n.test.mjs).
 */
export function readSource(url) {
    return untranslate(readFileSync(url, 'utf8'));
}

function readString(source, start) {
    const quote = source[start];
    let index = start + 1;
    let value = '';
    while (index < source.length && source[index] !== quote) {
        if (source[index] === '\\') {
            const next = source[index + 1];
            value += next === 'n' ? '\n' : next === 'u' ? String.fromCharCode(parseInt(source.slice(index + 2, index + 6), 16)) : next;
            index += next === 'u' ? 6 : 2;
        } else value += source[index++];
    }
    return { value, end: index + 1 };
}

/** Splits `, a, b)` into argument source texts; returns the index after `)`. */
function readArgs(source, start) {
    const args = [];
    let depth = 0;
    let current = '';
    let index = start;
    for (; index < source.length; index++) {
        const char = source[index];
        if (char === '\'' || char === '"' || char === '`') {
            const end = char === '`' ? skipTemplate(source, index) : readString(source, index).end;
            current += source.slice(index, end);
            index = end - 1;
            continue;
        }
        if ('([{'.includes(char)) depth++;
        if (')]}'.includes(char)) {
            if (depth === 0) break;
            depth--;
        }
        if (char === ',' && depth === 0) {
            if (current.trim()) args.push(current.trim());
            current = '';
            continue;
        }
        current += char;
    }
    if (current.trim()) args.push(current.trim());
    return { args, end: index + 1 };
}

function skipTemplate(source, start) {
    let index = start + 1;
    while (index < source.length && source[index] !== '`') {
        if (source[index] === '\\') index += 2;
        else if (source[index] === '$' && source[index + 1] === '{') {
            let depth = 1;
            index += 2;
            while (index < source.length && depth) {
                if (source[index] === '{') depth++;
                else if (source[index] === '}') depth--;
                index++;
            }
        } else index++;
    }
    return index + 1;
}

export function untranslate(source) {
    let out = '';
    let index = 0;
    const pattern = /(?<![\w$.])t\((?=['"])/g;
    let match;
    while ((match = pattern.exec(source))) {
        const callStart = match.index;
        const { value, end: stringEnd } = readString(source, callStart + 2);
        const { args, end } = readArgs(source, stringEnd);
        const before = source.slice(index, callStart);
        const after = source[end];
        const inJsxChild = before.endsWith('{') && after === '}' && !/=\s*\{$/.test(before);
        const inAttribute = /=\{$/.test(before) && after === '}';
        const filled = args.length ? value.replace(/\{(\d+)\}/g, (_m, n) => inJsxChild ? `{${args[Number(n)]}}` : `\${${args[Number(n)]}}`) : value;
        if (inJsxChild) {
            out += before.slice(0, -1).replace(/\{' '\}$/, ' ') + filled;
            index = end + 1;
            if (source.startsWith('{\' \'}', index)) { out += ' '; index += 5; }
        } else if (inAttribute && !args.length && !value.includes('"')) {
            out += `${before.slice(0, -1)}"${value}"`;
            index = end + 1;
        } else if (args.length) {
            out += `${before}\`${filled}\``;
            index = end;
        } else {
            out += `${before}'${value.replace(/'/g, '\\\'')}'`;
            index = end;
        }
        pattern.lastIndex = index;
    }
    return out + source.slice(index);
}
