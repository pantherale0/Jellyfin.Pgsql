import { h, render } from 'preact';
import '../../src/style.css';
import { createAdminApi } from '../../src/admin/admin-api';
import { AdminPlayback } from '../../src/admin/pages/admin-playback';
import { JellyfinApi } from '../../src/api';
import { loadMessages } from '../../src/i18n';

if (new URLSearchParams(window.location.search).get('testLocale') === 'fr') {
    loadMessages('fr', {
        'Unknown stage': 'Étape inconnue',
        'Unknown framework': 'Moteur inconnu',
        'Unknown media type': 'Type de média inconnu',
    });
}

const root = document.getElementById('app');
if (!root) throw new Error('Transcoding pipeline fixture root is missing.');

const session = new JellyfinApi({
    server: window.location.origin,
    token: 'fixture-admin-token',
    serverId: 'fixture-server-id',
    user: { Id: 'fixture-admin-id', Name: 'Fixture admin', Policy: { IsAdministrator: true } },
});

render(h(AdminPlayback, { adminApi: createAdminApi(session) }), root);
