#!/usr/bin/env node
// Updates UI Next's local English message catalog and prunes stale locale entries.
//
// UI Next messages are keyed by their English text (`t('Sign out')`). Existing translations stay
// in the committed locale tables. New messages render in English until a locale entry is added.
//
// Usage: node scripts/sync-ui-next-strings.mjs [--check]
//   --check  exit 1 (without writing) when the committed catalogs are out of date.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = join(repo, 'ui-next/src');
const i18nDir = join(sourceRoot, 'i18n');
const localesDir = join(i18nDir, 'locales');
const catalogDir = join(i18nDir, 'catalog');
const check = process.argv.includes('--check');

const sourceFiles = [];
const walk = dir => readdirSync(dir).forEach(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.tsx?$/.test(name)) sourceFiles.push(path);
});
walk(sourceRoot);

const unescape = (raw, quote) => raw.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_match, code) => {
    if (code[0] === 'u') return String.fromCodePoint(parseInt(code.replace(/[u{}]/g, ''), 16));
    if (code[0] === 'x' && code.length === 3) return String.fromCharCode(parseInt(code.slice(1), 16));
    return { n: '\n', t: '\t', r: '\r', [quote]: quote }[code] ?? code;
});

/** Literal first arguments of `t(...)`; dynamic calls (`t(label)`) translate values that are themselves literals elsewhere. */
function messagesIn(source) {
    const found = new Set();
    const pattern = /(?<![\w$.])t\(\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\$]|\\.)*)`)/g;
    for (const match of source.matchAll(pattern)) {
        const [ , single, double, template ] = match;
        found.add(unescape(single ?? double ?? template, single !== undefined ? '\'' : double !== undefined ? '"' : '`'));
    }
    return found;
}

const messages = new Set();
for (const file of sourceFiles) {
    if (file.startsWith(i18nDir)) continue;
    messagesIn(readFileSync(file, 'utf8')).forEach(message => messages.add(message));
}

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const english = Object.fromEntries([ ...messages ].sort().map(message => [message, message]));
const outputs = new Map();
const json = value => `${JSON.stringify(value, null, 2)}\n`;
outputs.set(join(catalogDir, 'en-ui-next.json'), json(english));

for (const file of readdirSync(localesDir).filter(name => name.endsWith('.json')).sort()) {
    const language = file.replace(/\.json$/, '').replace(/_/g, '-').toLowerCase();
    if (language === 'en' || language.startsWith('en-')) continue;
    const previous = readJson(join(localesDir, file));
    const table = {};
    for (const message of Object.keys(english)) {
        const translated = previous[message];
        if (typeof translated === 'string' && translated.trim() && translated !== message) table[message] = translated;
    }
    if (Object.keys(table).length) outputs.set(join(localesDir, `${language}.json`), json(table));
}

const stale = [
    ...(existsSync(localesDir) ? readdirSync(localesDir).map(name => join(localesDir, name)).filter(path => !outputs.has(path)) : []),
    join(catalogDir, 'jellyfin-keys.json')
].filter(existsSync);
const changed = [ ...outputs ].filter(([ path, content ]) => !existsSync(path) || readFileSync(path, 'utf8') !== content).map(([ path ]) => path);

if (check) {
    if (changed.length || stale.length) {
        console.error(`UI Next catalogs are out of date (${changed.length} changed, ${stale.length} stale). Run: node scripts/sync-ui-next-strings.mjs`);
        process.exit(1);
    }
    console.log(`UI Next strings are current: ${messages.size} English messages, ${outputs.size - 1} locale files.`);
    process.exit(0);
}

mkdirSync(localesDir, { recursive: true });
mkdirSync(catalogDir, { recursive: true });
stale.forEach(path => rmSync(path));
for (const path of changed) writeFileSync(path, outputs.get(path));
console.log(`${messages.size} English messages and ${outputs.size - 1} locale files (${changed.length} written, ${stale.length} removed).`);
