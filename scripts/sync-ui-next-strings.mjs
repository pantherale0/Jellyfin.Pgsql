#!/usr/bin/env node
// Builds UI Next's locale tables from Jellyfin Web's translations.
//
// UI Next messages are keyed by their English text (`t('Sign out')`). For every message whose
// English text matches a Jellyfin Web string (exactly, then case-insensitively), each Jellyfin Web
// locale contributes its translation to `ui-next/src/i18n/locales/<language>.json`. Messages with no
// match are listed in `ui-next/src/i18n/catalog/en-ui-next.json` and render in English everywhere.
// The output is committed, so building UI Next never needs the jellyfin-web submodule.
//
// Usage: node scripts/sync-ui-next-strings.mjs [--check]
//   --check  exit 1 (without writing) when the committed files are out of date.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = join(repo, 'ui-next/src');
const stringsDir = join(repo, 'jellyfin-web/src/strings');
const i18nDir = join(sourceRoot, 'i18n');
const localesDir = join(i18nDir, 'locales');
const catalogDir = join(i18nDir, 'catalog');
const check = process.argv.includes('--check');

if (!existsSync(join(stringsDir, 'en-us.json'))) {
    console.error(`Missing ${relative(repo, stringsDir)}/en-us.json. Run: git submodule update --init jellyfin-web`);
    process.exit(2);
}

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
const english = readJson(join(stringsDir, 'en-us.json'));
const exact = new Map();
const folded = new Map();
for (const key of Object.keys(english).sort()) {
    const value = english[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    if (!exact.has(value)) exact.set(value, key);
    if (!folded.has(value.toLowerCase())) folded.set(value.toLowerCase(), key);
}

const placeholders = text => [ ...text.matchAll(/\{(\d+)\}/g) ].map(match => match[1]).sort().join(',');
const keys = {};
const uiNextOnly = {};
for (const message of [ ...messages ].sort()) {
    const key = exact.get(message) ?? folded.get(message.toLowerCase());
    if (key && placeholders(english[key]) === placeholders(message)) keys[message] = key;
    else uiNextOnly[message] = message;
}

const outputs = new Map();
const json = value => `${JSON.stringify(value, null, 2)}\n`;
outputs.set(join(catalogDir, 'jellyfin-keys.json'), json(keys));
outputs.set(join(catalogDir, 'en-ui-next.json'), json(uiNextOnly));

for (const file of readdirSync(stringsDir).filter(name => name.endsWith('.json')).sort()) {
    const language = file.replace(/\.json$/, '').replace(/_/g, '-').toLowerCase();
    // UI Next's own text is the English source; Jellyfin Web's English variants only recapitalise it.
    if (language === 'en' || language.startsWith('en-')) continue;
    const strings = readJson(join(stringsDir, file));
    const table = {};
    for (const [ message, key ] of Object.entries(keys)) {
        const translated = strings[key];
        if (typeof translated === 'string' && translated.trim() && translated !== message && placeholders(translated) === placeholders(message)) table[message] = translated;
    }
    if (Object.keys(table).length) outputs.set(join(localesDir, `${language}.json`), json(table));
}

const stale = existsSync(localesDir) ? readdirSync(localesDir).map(name => join(localesDir, name)).filter(path => !outputs.has(path)) : [];
const changed = [ ...outputs ].filter(([ path, content ]) => !existsSync(path) || readFileSync(path, 'utf8') !== content).map(([ path ]) => path);

if (check) {
    if (changed.length || stale.length) {
        console.error(`UI Next strings are out of date (${changed.length} changed, ${stale.length} stale). Run: node scripts/sync-ui-next-strings.mjs`);
        process.exit(1);
    }
    console.log(`UI Next strings are current: ${messages.size} messages, ${Object.keys(keys).length} from Jellyfin Web.`);
    process.exit(0);
}

mkdirSync(localesDir, { recursive: true });
mkdirSync(catalogDir, { recursive: true });
stale.forEach(path => rmSync(path));
for (const path of changed) writeFileSync(path, outputs.get(path));
console.log(`${messages.size} messages: ${Object.keys(keys).length} reuse Jellyfin Web strings, ${Object.keys(uiNextOnly).length} are UI Next only; ${outputs.size - 2} locale files (${changed.length} written, ${stale.length} removed).`);
