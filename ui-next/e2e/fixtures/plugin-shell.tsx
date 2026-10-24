import { h, render } from 'preact';
import { PluginPageShell } from '../../src/admin/plugin-shell';

const root = document.getElementById('app');
if (!root) throw new Error('Plugin shell fixture root is missing.');

render(h(PluginPageShell, {
    name: 'Fixture plugin',
    session: { server: 'http://127.0.0.1:8097' },
    loaded: true,
    children: h('p', null, 'Fixture settings')
}), root);
