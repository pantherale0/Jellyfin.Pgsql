import { useEffect, useState } from 'preact/hooks';
import { Card, ConfirmButton, InfoRow, SettingsFields } from '../ui';
import {
    accelerationDetected, allSupportedCodecs, decodingCodecsFor, detectedDecoders, ENCODING_CONFIG_PATH, encodingPatch, HWA_TYPES,
    missingHardwareEncoders, toggleCodec, transcodingSections, validateTranscoding, type EncoderCapabilities,
} from '../transcoding-settings';
import { t } from '../../i18n';

interface TranscodingApi {
    getConfig<T extends Record<string, unknown> = Record<string, any>>(path: string): Promise<T>;
    saveConfigPatch(path: string, patch: Record<string, unknown>): Promise<Record<string, any>>;
    getMediaEncoderCapabilities(): Promise<Record<string, any> | null>;
}

/** Server-wide transcoding settings; saves only changed fields onto a freshly read encoding document. */
export function TranscodingSettings({ api }: { api: TranscodingApi }) {
    const [ saved, setSaved ] = useState<Record<string, any> | null>(null);
    const [ draft, setDraft ] = useState<Record<string, any>>({});
    const [ capabilities, setCapabilities ] = useState<EncoderCapabilities | null>(null);
    const [ loadError, setLoadError ] = useState('');
    const [ message, setMessage ] = useState('');
    const [ revision, setRevision ] = useState(0);
    useEffect(() => {
        let active = true;
        setSaved(null); setLoadError('');
        api.getConfig(ENCODING_CONFIG_PATH).then(config => { if (active) { setSaved(config); setDraft(config); } })
            .catch(e => { if (active) setLoadError(e instanceof Error ? e.message : t('Transcoding settings could not be loaded.')); });
        api.getMediaEncoderCapabilities().then(caps => { if (active) setCapabilities(caps as EncoderCapabilities | null); }).catch(() => undefined);
        return () => { active = false; };
    }, [ api ]);

    if (loadError) return <Card title={t('Transcoding settings')}><p role="alert" class="ad-error">{t('{0} Settings cannot be saved until they load.', loadError)}</p></Card>;
    if (!saved) return <Card title={t('Transcoding settings')}><p role="status" class="ad-note">{t('Loading settings…')}</p></Card>;

    const type = String(draft.HardwareAccelerationType || 'none');
    const patch = encodingPatch(saved, draft);
    const dirty = Object.keys(patch).length > 0;
    const change = (next: Record<string, any>) => { setDraft(next); setMessage(''); };
    const codecs = decodingCodecsFor(type);
    const detected = detectedDecoders(capabilities, type);
    const missingEncoders = missingHardwareEncoders(capabilities, type);
    const sections = transcodingSections(type);

    return <>
        <Card title={t('Hardware acceleration')}>
            <div class="ad-form-grid">
                <div class="ad-form-field">
                    <label class="ad-form-label" for="transcoding-hwa">{t('Acceleration type')}</label>
                    <select id="transcoding-hwa" class="ad-form-input" value={type} onChange={e => change({ ...draft, HardwareAccelerationType: e.currentTarget.value })}>
                        {HWA_TYPES.map(([ value, label ]) => <option key={value} value={value} disabled={value !== type && !accelerationDetected(capabilities, value)}>{label}{accelerationDetected(capabilities, value) ? '' : t(' (not detected)')}</option>)}
                    </select>
                    <span class="ad-note"><a href="https://jellyfin.org/docs/general/post-install/transcoding/hardware-acceleration/" target="_blank" rel="noopener noreferrer">{t('Hardware acceleration guide')}</a></span>
                    {!accelerationDetected(capabilities, type) && <span role="alert" class="ad-error">{t('FFmpeg on this server did not detect this acceleration type. A restart may be needed after changing drivers or FFmpeg.')}</span>}
                </div>
                <InfoRow k={t('FFmpeg path')} v={saved.EncoderAppPathDisplay || t('Not reported')} />
            </div>
            {codecs.length > 0 && <fieldset class="ad-codec-grid">
                <legend class="ad-form-label">{t('Hardware decoding for')}</legend>
                {codecs.map(codec => {
                    const supported = !detected || detected.has(codec.codec);
                    return <label key={codec.codec} class="ad-toggle-row">
                        <span>{codec.name}{supported ? '' : <small class="ad-note">{t('· not detected')}</small>}</span>
                        <input type="checkbox" checked={(draft.HardwareDecodingCodecs || []).includes(codec.codec)} onChange={e => change({ ...draft, HardwareDecodingCodecs: toggleCodec(draft.HardwareDecodingCodecs, codec.codec, e.currentTarget.checked) })} />
                    </label>;
                })}
                {capabilities && <button type="button" class="ad-btn" onClick={() => change({ ...draft, HardwareDecodingCodecs: allSupportedCodecs(type, capabilities) })}>{t('Enable all supported')}</button>}
            </fieldset>}
            {missingEncoders.length > 0 && <p class="ad-note">{t('Hardware encoders not detected for this type: {0}. Those formats fall back to software encoding.', missingEncoders.join(', '))}</p>}
        </Card>
        {sections.map(section => <Card key={`${section.title}-${type}`} title={section.title}>
            <SettingsFields key={`${revision}-${type}`} fields={section.title === 'Encoding formats' ? section.fields.filter(field => field.key !== 'EnableParallelCodecRace') : section.fields} draft={draft} onChange={change} />
            {section.title === 'Encoding formats' && <SettingsFields key={`${revision}-race`} fields={section.fields.filter(field => field.key === 'EnableParallelCodecRace')} draft={draft} onChange={change} disabled={draft.EnableTranscodeCodecFallback === false} />}
            {section.note && <p class="ad-note">{section.note}</p>}
        </Card>)}
        <Card>
            <p class="ad-note">{t('Hardware acceleration can be unstable with outdated drivers. If playback breaks after a change, set the acceleration type back to None. Changes apply to new transcodes.')}</p>
            <div class="ad-flex">
                {!dirty ? <button class="ad-btn" disabled>{t('Save transcoding settings')}</button> : <ConfirmButton label={t('Save transcoding settings')} onConfirm={async () => {
                    const problem = validateTranscoding(draft);
                    if (problem) throw new Error(problem);
                    const next = await api.saveConfigPatch(ENCODING_CONFIG_PATH, patch);
                    setSaved(next); setDraft(next); setRevision(value => value + 1); setMessage(t('Transcoding settings saved.'));
                }} />}
                <button class="ad-btn" disabled={!dirty} onClick={() => { setDraft(saved); setRevision(value => value + 1); setMessage(''); }}>{t('Discard')}</button>
                {dirty && <span class="ad-note">{t('{0} unsaved', Object.keys(patch).length)}{' '}{Object.keys(patch).length === 1 ? 'change' : 'changes'}</span>}
            </div>
            {message && <p role="status" class="ad-note">{message}</p>}
        </Card>
    </>;
}
