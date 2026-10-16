import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import ts from 'typescript';

registerHooks({
    resolve(specifier, context, nextResolve) {
        return nextResolve(specifier.startsWith('.') && !extname(specifier) ? `${specifier}.ts` : specifier, context);
    }
});

const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) };

const i18n = await import('../src/i18n.ts');
afterEach(() => i18n.loadMessages('en-us', {}));

const srcRoot = fileURLToPath(new URL('../src/', import.meta.url));
const sourceFiles = [];
const walk = dir => readdirSync(dir).forEach(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.tsx?$/.test(name)) sourceFiles.push(path);
});
walk(srcRoot);
const catalog = file => JSON.parse(readFileSync(new URL(`../src/i18n/catalog/${file}`, import.meta.url), 'utf8'));

test('t() returns English text, fills {0} placeholders and uses the loaded table', () => {
    assert.equal(i18n.t('Play'), 'Play');
    assert.equal(i18n.t('Show more ({0} remaining)', 12), 'Show more (12 remaining)');
    assert.equal(i18n.t('{1} of {0}', 'all', 3), '3 of all');
    assert.equal(i18n.t('Missing {0} and {1}', 'one'), 'Missing one and {1}');
    i18n.loadMessages('fr', { Play: 'Lire', 'Show more ({0} remaining)': 'Afficher plus ({0} restants)' });
    assert.equal(i18n.t('Play'), 'Lire');
    assert.equal(i18n.t('Show more ({0} remaining)', 4), 'Afficher plus (4 restants)');
    assert.equal(i18n.t('Untranslated'), 'Untranslated');
});

test('language candidates fall back from region to base language to English', () => {
    const available = [ 'fr', 'fr-ca', 'pt-br', 'pt-pt', 'zh-cn', 'ar' ];
    assert.deepEqual(i18n.languageCandidates('fr-CA', available), [ 'fr-ca', 'fr', 'en-us' ]);
    assert.deepEqual(i18n.languageCandidates('fr-BE', available), [ 'fr', 'en-us' ]);
    assert.deepEqual(i18n.languageCandidates('pt', available), [ 'pt-br', 'en-us' ]);
    assert.deepEqual(i18n.languageCandidates('ar_SA', available), [ 'ar', 'en-us' ]);
    assert.deepEqual(i18n.languageCandidates('de', available), [ 'en-us' ]);
    assert.deepEqual(i18n.languageCandidates('en-GB', [ ...available, 'en-gb' ]), [ 'en-us' ], 'English variants keep UI Next text');
    assert.equal(i18n.normalizeLanguage(' pt_BR '), 'pt-br');
});

test('setLocale lazy-loads the best table and survives a failing loader', async () => {
    const loaded = [];
    const loaders = {
        fr: async () => { loaded.push('fr'); return { default: { Play: 'Lire' } }; },
        'fr-ca': async () => { loaded.push('fr-ca'); throw new Error('chunk failed'); },
        ar: async () => ({ default: { Play: 'تشغيل' } }),
    };
    assert.equal(await i18n.setLocale('fr-CA', loaders), 'fr');
    assert.deepEqual(loaded, [ 'fr-ca', 'fr' ]);
    assert.equal(i18n.t('Play'), 'Lire');
    assert.equal(i18n.locale(), 'fr');
    assert.equal(i18n.textDirection(), 'ltr');
    assert.equal(await i18n.setLocale('ar', loaders), 'ar');
    assert.equal(i18n.textDirection(), 'rtl');
    assert.equal(await i18n.setLocale('de', loaders), 'en-us');
    assert.equal(i18n.t('Play'), 'Play');
    assert.equal(i18n.locale(), 'en-US');
});

test('RTL languages match Jellyfin Web (ar, fa, ur, he) including regional codes', () => {
    for (const code of [ 'ar', 'ar-sa', 'fa', 'ur-pk', 'he', 'he_IL' ]) assert.equal(i18n.isRtlLanguage(code), true, code);
    for (const code of [ 'en-us', 'fr', 'zh-cn', '' ]) assert.equal(i18n.isRtlLanguage(code), false, code);
});

test('the language is stored per user under Jellyfin Web key', () => {
    i18n.storeLanguage('user-1', 'pt_BR');
    assert.equal(storage.get('user-1-language'), 'pt-br');
    assert.equal(i18n.readStoredLanguage('user-1'), 'pt-br');
    i18n.storeLanguage('user-1', '');
    assert.equal(i18n.readStoredLanguage('user-1'), '');
    assert.equal(i18n.readStoredLanguage(undefined), '');
});

test('Intl formatting follows the active language', () => {
    assert.equal(i18n.formatNumber(1234.5), '1,234.5');
    i18n.loadMessages('de', {});
    assert.equal(i18n.formatNumber(1234.5), '1.234,5');
    assert.equal(i18n.formatDate('2026-03-01T12:00:00Z', { year: 'numeric', month: 'long', timeZone: 'UTC' }), 'März 2026');
    assert.equal(i18n.formatDate('not a date'), '');
});

test('every literal t() message is catalogued (run scripts/sync-ui-next-strings.mjs after adding text)', () => {
    const known = new Set([ ...Object.keys(catalog('jellyfin-keys.json')), ...Object.keys(catalog('en-ui-next.json')) ]);
    const missing = [];
    for (const file of sourceFiles) {
        if (file.includes(`${join('src', 'i18n')}/`)) continue;
        const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
        const visit = node => {
            if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 't' && node.arguments[0]
                && (ts.isStringLiteral(node.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(node.arguments[0])) && !known.has(node.arguments[0].text)) {
                missing.push(`${relative(srcRoot, file)}: ${node.arguments[0].text}`);
            }
            ts.forEachChild(node, visit);
        };
        visit(sf);
    }
    assert.deepEqual(missing, []);
});

test('locale tables only translate catalogued messages and keep their placeholders', () => {
    const keys = catalog('jellyfin-keys.json');
    const placeholders = text => [ ...text.matchAll(/\{(\d+)\}/g) ].map(match => match[1]).sort().join(',');
    const locales = readdirSync(new URL('../src/i18n/locales/', import.meta.url));
    assert.ok(locales.length > 50, 'Jellyfin Web translations are committed');
    assert.ok(!locales.some(name => name.startsWith('en')), 'English variants are not shipped');
    for (const name of [ 'fr.json', 'de.json', 'ar.json', 'zh-cn.json' ]) {
        const table = JSON.parse(readFileSync(new URL(`../src/i18n/locales/${name}`, import.meta.url), 'utf8'));
        for (const [ message, translated ] of Object.entries(table)) {
            assert.ok(message in keys, `${name}: ${message}`);
            assert.equal(placeholders(translated), placeholders(message), `${name}: ${message}`);
        }
    }
});

const ALLOWED_TEXT = new Set([ 'HDR', 'CC', 'library.db', 'users.db', '?local=true' ]);

test('JSX has no raw user-visible text or literal aria-label/placeholder/title/alt', () => {
    const raw = [];
    for (const file of sourceFiles.filter(path => path.endsWith('.tsx'))) {
        const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        const where = node => `${relative(srcRoot, file)}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
        const visit = node => {
            if (ts.isJsxText(node) && /[A-Za-z]{2,}/.test(node.text) && !ALLOWED_TEXT.has(node.text.trim())) raw.push(`${where(node)} text "${node.text.trim()}"`);
            if (ts.isJsxAttribute(node) && [ 'aria-label', 'placeholder', 'title', 'alt' ].includes(node.name.getText())
                && node.initializer && ts.isStringLiteral(node.initializer) && /[A-Za-z]{2,}/.test(node.initializer.text)) raw.push(`${where(node)} ${node.name.getText()}="${node.initializer.text}"`);
            ts.forEachChild(node, visit);
        };
        visit(sf);
    }
    assert.deepEqual(raw, []);
});

test('the app boots through the locale loader so module-level labels are translated', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    assert.match(html, /<script type="module" src="\/src\/boot\.ts"><\/script>/);
    const boot = readFileSync(new URL('../src/boot.ts', import.meta.url), 'utf8');
    assert.match(boot, /setLocale\(readStoredLanguage\(storedUserId\(\)\), localeLoaders\)[\s\S]*import\('\.\/main'\)/);
    assert.match(readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8'), /const SESSION_KEY = 'jellyfin-ui-next-session';/);
});
