import { HomeSectionsEditor } from './discovery-views';
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useDialogFocus } from './dialog-focus';
import { userMessage } from './ui-errors';
import { normalizeLayoutChoice, readLayoutChoice, saveLayoutChoice, type LayoutChoice } from './layout-mode';
import { JellyfinApi } from './api';
import type { RememberedUser } from './remembered-users';
import type { JellyfinUser, Session, TasteProfile, UserConfiguration } from './types';
import { mergeEditedFields } from './auth-state';
import { hostSupports } from './native-host';
import { base64FromDataUrl, userImageUrl, validateAvatar, validatePasswordChange } from './account';
import { loadControlPreferences, saveControlPreferences, type ControlPreferences, type SmoothScrollChoice } from './controls';
import { AUDIO_CHANNEL_CHOICES, BITRATE_CHOICES, loadPlaybackPreferences, RESOLUTION_CHOICES, savePlaybackPreferences, SUBTITLE_BURN_IN_CHOICES, type PlaybackPreferences, type SubtitleBurnIn } from './device-profile';
import { loadSegmentActions, saveSegmentAction, SEGMENT_KINDS, SEGMENT_LABELS, type SegmentAction } from './player-model';
import { CAPTION_CHOICES, captionCss, loadCaptionStyle, saveCaptionStyle, type CaptionStyle } from './caption-style';
import { browserLanguage, formatNumber, languageName, readStoredLanguage, storeLanguage, t } from './i18n';
import { localeLoaders } from './i18n/loaders';
import { loadMusicSettings, MAX_CROSSFADE_SECONDS, saveMusicSettings, type NormalizationMode } from './music-settings';
import { loadDisplaySettings, saveDisplaySettings, TEXT_SIZES, type DisplaySettings, type TextSize, type ThemeChoice } from './display-settings';

export type ProfileScreenName = 'quickconnect' | 'playback' | 'subtitles' | 'taste' | 'accounts' | 'account' | 'controls' | 'display' | 'home';

interface ProfileScreenProps {
    screen: ProfileScreenName;
    api: JellyfinApi;
    session: Session;
    isAdministrator: boolean;
    rememberedUsers?: RememberedUser[];
    onSelectRemembered?: (user: RememberedUser) => void;
    onSignInAnother?: () => void;
    onBack: () => void;
}

export function ProfileScreen({ screen, api, session, isAdministrator, rememberedUsers = [], onSelectRemembered, onSignInAnother, onBack }: ProfileScreenProps) {
    const [ loading, setLoading ] = useState(true);
    const [ saving, setSaving ] = useState(false);
    const [ error, setError ] = useState('');
    const [ saved, setSaved ] = useState(false);
    const [ configuration, setConfiguration ] = useState<UserConfiguration>({});
    const [ configLoaded, setConfigLoaded ] = useState(false);
    const [ languages, setLanguages ] = useState<Array<{ ThreeLetterISOLanguageName: string; DisplayName: string }>>([]);
    const screenRef = useRef(screen);
    screenRef.current = screen;
    const saveOp = useRef(0);
    const editedKeys = useRef(new Set<keyof UserConfiguration>());
    const [ code, setCode ] = useState('');
    const [ users, setUsers ] = useState<JellyfinUser[]>([]);
    const [ selectedUserId, setSelectedUserId ] = useState(session.user.Id);
    const [ taste, setTaste ] = useState<TasteProfile | null>(null);
    const [ devicePreferences, setDevicePreferences ] = useState<PlaybackPreferences>(() => loadPlaybackPreferences());
    const updateDevicePreference = (change: Partial<PlaybackPreferences>) => setDevicePreferences(savePlaybackPreferences(change));
    const [ controls, setControls ] = useState<ControlPreferences>(() => loadControlPreferences());
    const [ display, setDisplay ] = useState<DisplaySettings>(() => loadDisplaySettings());
    const [ segmentActions, setSegmentActions ] = useState(() => loadSegmentActions());
    const [ music, setMusic ] = useState(() => loadMusicSettings());
    const [ captionStyle, setCaptionStyle ] = useState<CaptionStyle>(() => loadCaptionStyle());
    const updateCaptionStyle = (change: Partial<CaptionStyle>) => setCaptionStyle(saveCaptionStyle(change));
    const [ account, setAccount ] = useState<JellyfinUser | null>(null);
    const [ passwords, setPasswords ] = useState({ current: '', next: '', confirm: '' });
    const [ accountMessage, setAccountMessage ] = useState('');
    const [ initialLayout ] = useState<LayoutChoice>(() => readLayoutChoice());
    const [ layoutChoice, setLayoutChoice ] = useState<LayoutChoice>(initialLayout);
    const accountsRef = useRef<HTMLElement>(null);
    const dialogRef = useRef<HTMLElement>(null);
    const onBackRef = useRef(onBack);
    onBackRef.current = onBack;

    useEffect(() => {
        if (screen !== 'accounts' || loading) return;
        accountsRef.current?.querySelector<HTMLElement>('[data-current-user="true"], .remembered-user')?.focus();
    }, [ screen, loading ]);

    useDialogFocus(dialogRef, screen === 'quickconnect', () => onBackRef.current(), {
        initial: 'input, select',
        fallback: () => document.querySelector<HTMLElement>('.profile-button')
    });

    useEffect(() => {
        let active = true;
        setLoading(true);
        setError('');
        setSaved(false);
        setSaving(false);
        setConfigLoaded(false);
        saveOp.current += 1;
        editedKeys.current = new Set();
        setAccountMessage('');
        if (screen === 'accounts' || screen === 'controls' || screen === 'display' || screen === 'home') {
            setLoading(false);
        } else if (screen === 'account') {
            void api.getUser().then(user => {
                if (active) setAccount(user);
            }).catch(cause => {
                if (active) setError(messageOf(cause));
            }).finally(() => { if (active) setLoading(false); });
        } else if (screen === 'playback' || screen === 'subtitles') {
            const configRequest = api.getUserConfiguration();
            const languageRequest = screen === 'subtitles' ? api.getCultures() : Promise.resolve([]);
            void Promise.all([ configRequest, languageRequest ]).then(([ nextConfig, nextLanguages ]) => {
                if (!active) return;
                setConfiguration(nextConfig);
                setLanguages(nextLanguages);
                setConfigLoaded(true);
            }).catch(cause => {
                if (active) setError(messageOf(cause));
            }).finally(() => { if (active) setLoading(false); });
        } else if (screen === 'taste') {
            void api.getTasteProfile().then(value => {
                if (active) setTaste(value);
            }).catch(cause => {
                if (active) setError(messageOf(cause));
            }).finally(() => { if (active) setLoading(false); });
        } else {
            const usersRequest = isAdministrator ? JellyfinApi.getUsers(session) : Promise.resolve([]);
            void usersRequest.then(value => {
                if (active) setUsers(value.filter(user => !user.Policy?.IsDisabled));
            }).catch(cause => {
                if (active) setError(messageOf(cause));
            }).finally(() => { if (active) setLoading(false); });
        }
        return () => { active = false; };
    }, [ api, isAdministrator, screen, session ]);

    const updateConfiguration = (key: keyof UserConfiguration, value: unknown) => {
        setSaved(false);
        editedKeys.current.add(key);
        setConfiguration(current => ({ ...current, [key]: value }));
    };

    const saveConfiguration = async (event: Event) => {
        event.preventDefault();
        if (!configLoaded) return;
        const savedScreen = screen;
        const operation = ++saveOp.current;
        const current = (op: number) => saveOp.current === op && screenRef.current === savedScreen;
        setSaving(true);
        setError('');
        setSaved(false);
        try {
            const fresh = await api.getUser();
            if (!current(operation)) return;
            const edited = Array.from(editedKeys.current);
            const merged = mergeEditedFields(fresh.Configuration as Record<string, unknown> | undefined, configuration as Record<string, unknown>, edited as string[]) as UserConfiguration;
            await api.updateUserConfiguration(merged);
            if (current(operation)) {
                edited.forEach(key => editedKeys.current.delete(key));
                setConfiguration(merged);
                setSaved(true);
            }
        } catch (cause) {
            if (current(operation)) setError(messageOf(cause));
        } finally {
            if (current(operation)) setSaving(false);
        }
    };

    const authorize = async (event: Event) => {
        event.preventDefault();
        setSaving(true);
        setError('');
        setSaved(false);
        try {
            const accepted = await JellyfinApi.authorizeQuickConnect(session, code, selectedUserId);
            if (!accepted) throw new Error(t('That Quick Connect code could not be authorized. Check the code and try again.'));
            setSaved(true);
            setCode('');
        } catch (cause) {
            setError(messageOf(cause));
        } finally {
            setSaving(false);
        }
    };

    const changePassword = async (event: Event) => {
        event.preventDefault();
        const problem = validatePasswordChange(passwords.current, passwords.next, passwords.confirm, account?.HasPassword !== false);
        setAccountMessage('');
        setError(problem);
        if (problem) return;
        setSaving(true);
        try {
            await api.changeOwnPassword(passwords.current, passwords.next);
            setPasswords({ current: '', next: '', confirm: '' });
            setAccount(current => current ? { ...current, HasPassword: true } : current);
            setAccountMessage(t('Password changed.'));
        } catch (cause) {
            setError(messageOf(cause));
        } finally {
            setSaving(false);
        }
    };

    const refreshAccount = async (message: string) => {
        const user = await api.getUser();
        if (screenRef.current !== 'account') return;
        setAccount(user);
        session.user.PrimaryImageTag = user.PrimaryImageTag;
        setAccountMessage(message);
    };

    const uploadAvatar = (event: Event) => {
        const input = event.currentTarget as HTMLInputElement;
        const file = input.files?.[0];
        input.value = '';
        if (!file) return;
        const problem = validateAvatar(file);
        setError(problem);
        setAccountMessage('');
        if (problem) return;
        const reader = new FileReader();
        reader.onerror = () => setError(t('The image could not be read.'));
        reader.onload = () => {
            const base64 = base64FromDataUrl(String(reader.result || ''));
            if (!base64) { setError(t('The image could not be read.')); return; }
            setSaving(true);
            void api.uploadOwnAvatar(base64, file.type).then(() => refreshAccount(t('Profile image updated.')))
                .catch(cause => setError(messageOf(cause))).finally(() => setSaving(false));
        };
        reader.readAsDataURL(file);
    };

    const removeAvatar = () => {
        setSaving(true);
        setError('');
        void api.deleteOwnAvatar().then(() => refreshAccount(t('Profile image removed.')))
            .catch(cause => setError(messageOf(cause))).finally(() => setSaving(false));
    };

    const updateControls = (change: Partial<ControlPreferences>) => setControls(saveControlPreferences(change));
    const updateDisplay = (change: Partial<DisplaySettings>) => setDisplay(saveDisplaySettings(change));
    const changeLanguage = (code: string) => {
        storeLanguage(session.user.Id, code);
        try { sessionStorage.removeItem('ui-next-language-reload'); } catch (_error) { /* Only guards the sign-in reload. */ }
        window.location.reload();
    };

    const title = screen === 'accounts' ? t('Switch user') : screen === 'quickconnect' ? t('Quick Connect')
        : screen === 'playback' ? t('Playback preferences')
            : screen === 'subtitles' ? t('Subtitle preferences')
                : screen === 'account' ? t('Account') : screen === 'controls' ? t('Controls') : screen === 'display' ? t('Display') : screen === 'home' ? t('Home screen') : t('Taste profile');

    if (screen === 'quickconnect') return <div class="profile-modal-backdrop" role="presentation" onClick={event => { if (event.target === event.currentTarget) onBack(); }}>
        <section ref={dialogRef} class="profile-modal" role="dialog" aria-modal="true" aria-labelledby="profile-page-title">
            <button class="profile-modal-close" data-focusable="true" type="button" aria-label={t('Close Quick Connect')} onClick={onBack}>×</button>
            <div class="profile-page-heading"><p class="eyebrow">{session.user.Name}</p><h1 id="profile-page-title">{t('Quick Connect')}</h1></div>
            {loading ? <p class="profile-status" role="status">{t('Loading…')}</p> : <>
                {error && <p class="notice error" role="alert">{error}</p>}
                {saved && <p class="notice success" role="status">{t('Device authorized.')}</p>}
                <form class="profile-form" onSubmit={authorize}>
                    <p>{t('Enter the code displayed by the device you want to connect.')}</p>
                    {isAdministrator && users.length > 0 && <label>{t('Authorize as')}
                        <select data-focusable="true" value={selectedUserId} onChange={event => setSelectedUserId((event.currentTarget as HTMLSelectElement).value)}>
                            {users.map(user => <option key={user.Id} value={user.Id}>{user.Name}</option>)}
                        </select>
                    </label>}
                    <label>{t('Quick Connect code')}
                        <input data-focusable="true" value={code} onInput={event => setCode((event.currentTarget as HTMLInputElement).value)} inputMode="numeric" pattern="[0-9\s]*" minLength={6} autoComplete="off" required />
                    </label>
                    <button class="button primary" data-focusable="true" type="submit" disabled={saving}>{saving ? t('Authorizing…') : t('Authorize device')}</button>
                </form>
            </>}
        </section>
    </div>;

    if (screen === 'accounts') return <section ref={accountsRef} class="account-picker" aria-labelledby="profile-page-title">
        <div class="account-picker-content">
            <button class="back-link account-picker-back" data-focusable="true" type="button" onClick={onBack} aria-label={t('Back to media')}><span class="dir-arrow" aria-hidden="true">←</span> <span>{t('Back')}</span></button>
            <h1 id="profile-page-title">{t('Who\'s watching?')}</h1>
            <p class="account-picker-hint">{t('Choose a profile to continue watching.')}</p>
            <div class="remembered-users" aria-label={t('Profiles')}>
                {rememberedUsers.map(user => <button key={user.userId} data-focusable="true" data-current-user={user.userId === session.user.Id ? 'true' : undefined} class="remembered-user" type="button" onClick={() => onSelectRemembered?.(user)} aria-label={`${user.name}, ${user.session ? 'continue watching' : 'sign in'}${user.userId === session.user.Id ? ', current user' : ''}`}>
                    <span class="remembered-user-avatar" style={{ background: profileColor(user.userId) }} aria-hidden="true">{user.name.slice(0, 1).toUpperCase()}</span>
                    <span class="remembered-user-name">{user.name}</span>
                    <span class="remembered-user-status">{user.userId === session.user.Id ? t('Current user') : user.session ? t('Continue watching') : t('Sign in required')}</span>
                </button>)}
                <button data-focusable="true" class="remembered-user remembered-user-add" type="button" onClick={onSignInAnother} aria-label={t('Sign in as another user')}>
                    <span class="remembered-user-avatar" aria-hidden="true">+</span><span class="remembered-user-name">{t('Another user')}</span><span class="remembered-user-status">{t('Sign in')}</span>
                </button>
            </div>
        </div>
    </section>;

    return <section class="profile-page" aria-labelledby="profile-page-title">
        <div class="profile-page-heading">
            <button class="back-link" data-focusable="true" type="button" onClick={onBack}><span class="dir-arrow" aria-hidden="true">←</span> <span>{t('Back')}</span></button>
            <p class="eyebrow">{session.user.Name}</p>
            <h1 id="profile-page-title">{title}</h1>
        </div>
        {loading ? <p class="profile-status" role="status">{t('Loading…')}</p> : <>
            {error && <p class="notice error" role="alert">{error}</p>}
            {saved && <p class="notice success" role="status">{t('Preferences saved.')}</p>}
            {screen === 'playback' && <form class="profile-form" onSubmit={saveConfiguration}>
                <label>{t('Preferred audio language')}<input data-focusable="true" value={configuration.AudioLanguagePreference || ''} onInput={event => updateConfiguration('AudioLanguagePreference', (event.currentTarget as HTMLInputElement).value)} placeholder={t('Any language')} /></label>
                <label class="profile-checkbox"><input data-focusable="true" type="checkbox" checked={configuration.PlayDefaultAudioTrack === true} onChange={event => updateConfiguration('PlayDefaultAudioTrack', (event.currentTarget as HTMLInputElement).checked)} />{' '}{t('Prefer default audio track')}</label>
                <label class="profile-checkbox"><input data-focusable="true" type="checkbox" checked={configuration.RememberAudioSelections === true} onChange={event => updateConfiguration('RememberAudioSelections', (event.currentTarget as HTMLInputElement).checked)} />{' '}{t('Remember audio track selections')}</label>
                <label class="profile-checkbox"><input data-focusable="true" type="checkbox" checked={configuration.RememberSubtitleSelections === true} onChange={event => updateConfiguration('RememberSubtitleSelections', (event.currentTarget as HTMLInputElement).checked)} />{' '}{t('Remember subtitle track selections')}</label>
                <label class="profile-checkbox"><input data-focusable="true" type="checkbox" checked={configuration.EnableNextEpisodeAutoPlay !== false} onChange={event => updateConfiguration('EnableNextEpisodeAutoPlay', (event.currentTarget as HTMLInputElement).checked)} />{' '}{t('Automatically play the next episode')}</label>
                <button class="button primary" data-focusable="true" type="submit" disabled={saving || !configLoaded}>{saving ? t('Saving…') : t('Save playback preferences')}</button>
            </form>}
            {screen === 'playback' && <section class="profile-form" aria-labelledby="device-playback-title">
                <h2 id="device-playback-title">{t('Quality on this device')}</h2>
                <p>{t('These are stored in this browser only and apply as soon as you change them. Server-wide streaming limits still apply.')}</p>
                <label>{t('Maximum bitrate')}
                    <select data-focusable="true" value={String(devicePreferences.maxBitrate)} onChange={event => updateDevicePreference({ maxBitrate: Number((event.currentTarget as HTMLSelectElement).value) })}>
                        {BITRATE_CHOICES.map(choice => <option key={choice.value} value={String(choice.value)}>{t(choice.label)}</option>)}
                    </select>
                </label>
                <label>{t('Maximum resolution')}
                    <select data-focusable="true" value={String(devicePreferences.maxHeight)} onChange={event => updateDevicePreference({ maxHeight: Number((event.currentTarget as HTMLSelectElement).value) })}>
                        {RESOLUTION_CHOICES.map(choice => <option key={choice.value} value={String(choice.value)}>{t(choice.label)}</option>)}
                    </select>
                </label>
                <label>{t('Maximum audio channels')}
                    <select data-focusable="true" value={String(devicePreferences.maxAudioChannels)} onChange={event => updateDevicePreference({ maxAudioChannels: Number((event.currentTarget as HTMLSelectElement).value) })}>
                        {AUDIO_CHANNEL_CHOICES.map(choice => <option key={choice.value} value={String(choice.value)}>{t(choice.label)}</option>)}
                    </select>
                </label>
                <label>{t('Converted stream format')}
                    <select data-focusable="true" value={devicePreferences.hlsContainer} onChange={event => updateDevicePreference({ hlsContainer: (event.currentTarget as HTMLSelectElement).value === 'mp4' ? 'mp4' : 'ts' })}>
                        <option value="ts">{t('HLS MPEG-TS (most compatible)')}</option>
                        <option value="mp4">{t('HLS fMP4 (allows HEVC)')}</option>
                    </select>
                </label>
                <label>{t('Layout on this device')}
                    <select data-focusable="true" value={layoutChoice} onChange={event => { const next = normalizeLayoutChoice((event.currentTarget as HTMLSelectElement).value); saveLayoutChoice(next); setLayoutChoice(next); }}>
                        <option value="auto">{t('Automatic')}</option>
                        <option value="tv">{t('TV (remote navigation)')}</option>
                        <option value="desktop">{t('Desktop and mobile')}</option>
                    </select>
                </label>
                {layoutChoice !== initialLayout && <p class="notice" role="status">{t('Reload UI Next to switch layout.')}{' '}<button class="button secondary" data-focusable="true" type="button" onClick={() => window.location.reload()}>{t('Reload now')}</button></p>}
            </section>}
            {screen === 'playback' && <section class="profile-form" aria-labelledby="segment-actions-title">
                <h2 id="segment-actions-title">{t('Skipping on this device')}</h2>
                <p>{t('Applies when the server has detected media segments for a title.')}</p>
                {SEGMENT_KINDS.map(kind => <label key={kind}>{SEGMENT_LABELS[kind]}
                    <select data-focusable="true" value={segmentActions[kind]} onChange={event => setSegmentActions(saveSegmentAction(kind, (event.currentTarget as HTMLSelectElement).value as SegmentAction))}>
                        <option value="ask">{t('Show a Skip button')}</option>
                        <option value="skip">{t('Skip automatically')}</option>
                        <option value="ignore">{t('Don\'t offer to skip')}</option>
                    </select>
                </label>)}
            </section>}
            {screen === 'playback' && <section class="profile-form" aria-labelledby="music-settings-title">
                <h2 id="music-settings-title">{t('Music on this device')}</h2>
                <p>{t('Volume levelling and crossfade need a browser that lets pages set the volume; iPhone and iPad Safari ignore them.')}</p>
                <label>{t('Volume levelling')}
                    <select data-focusable="true" value={music.normalization} onChange={event => setMusic(saveMusicSettings({ normalization: (event.currentTarget as HTMLSelectElement).value as NormalizationMode }))}>
                        <option value="album">{t('Album (keeps album dynamics)')}</option>
                        <option value="track">{t('Track')}</option>
                        <option value="off">{t('Off')}</option>
                    </select>
                </label>
                <label>{t('Crossfade')}
                    <select data-focusable="true" value={String(music.crossfadeSeconds)} onChange={event => setMusic(saveMusicSettings({ crossfadeSeconds: Number((event.currentTarget as HTMLSelectElement).value) }))}>
                        {Array.from({ length: MAX_CROSSFADE_SECONDS + 1 }, (_, seconds) => <option key={seconds} value={String(seconds)}>{seconds === 0 ? t('Off') : t('{0} s', seconds)}</option>)}
                    </select>
                </label>
                <label class="profile-checkbox"><input data-focusable="true" type="checkbox" checked={music.gapless} onChange={event => setMusic(saveMusicSettings({ gapless: (event.currentTarget as HTMLInputElement).checked }))} />{' '}{t('Gapless album playback (no crossfade between consecutive album tracks)')}</label>
            </section>}
            {screen === 'subtitles' && <form class="profile-form" onSubmit={saveConfiguration}>
                <label>{t('Preferred subtitle language')}
                    <select data-focusable="true" value={configuration.SubtitleLanguagePreference || ''} onChange={event => updateConfiguration('SubtitleLanguagePreference', (event.currentTarget as HTMLSelectElement).value)}>
                        <option value="">{t('Any language')}</option>
                        <option value="OriginalLanguage">{t('Original language')}</option>
                        {languages.map(language => <option key={language.ThreeLetterISOLanguageName} value={language.ThreeLetterISOLanguageName}>{language.DisplayName}</option>)}
                    </select>
                </label>
                <label>{t('Subtitle mode')}
                    <select data-focusable="true" value={String(configuration.SubtitleMode ?? 'Default')} onChange={event => updateConfiguration('SubtitleMode', (event.currentTarget as HTMLSelectElement).value)}>
                        <option value="Default">{t('Default')}</option><option value="Smart">{t('Smart')}</option><option value="OnlyForced">{t('Forced only')}</option><option value="Always">{t('Always play')}</option><option value="None">{t('None')}</option>
                    </select>
                </label>
                <button class="button primary" data-focusable="true" type="submit" disabled={saving || !configLoaded}>{saving ? t('Saving…') : t('Save subtitle preferences')}</button>
            </form>}
            {screen === 'subtitles' && <section class="profile-form" aria-labelledby="caption-style-title">
                <h2 id="caption-style-title">{t('Subtitle appearance on this device')}</h2>
                <p>{t('Applies to subtitles shown by the browser. Burned-in subtitles keep the server\'s rendering.')}</p>
                <style>{captionCss(captionStyle, '.caption-preview')}</style>
                <div class="caption-preview" aria-hidden="true"><span class="caption-preview-text">{t('The quick brown fox jumps over the lazy dog.')}</span></div>
                {(Object.keys(CAPTION_CHOICES) as Array<keyof typeof CAPTION_CHOICES>).map(key => <label key={key}>{({ size: t('Text size'), font: 'Font', weight: 'Weight', color: 'Colour', edge: t('Edge style') })[key]}
                    <select data-focusable="true" value={captionStyle[key]} onChange={event => updateCaptionStyle({ [key]: (event.currentTarget as HTMLSelectElement).value } as Partial<CaptionStyle>)}>
                        {CAPTION_CHOICES[key].map(([ value, label ]) => <option key={value} value={value}>{t(label)}</option>)}
                    </select>
                </label>)}
                <label>{t('Vertical position')}
                    <select data-focusable="true" value={String(captionStyle.position)} onChange={event => updateCaptionStyle({ position: Number((event.currentTarget as HTMLSelectElement).value) })}>
                        <option value="0">{t('Default')}</option>
                        {[ 1, 2, 3, 4, 6, 8 ].map(lines => <option key={lines} value={String(lines)}>{lines} {lines === 1 ? 'line' : 'lines'}{' '}{t('higher')}</option>)}
                    </select>
                </label>
                <label>{t('Burn-in')}
                    <select data-focusable="true" value={devicePreferences.subtitleBurnIn} onChange={event => updateDevicePreference({ subtitleBurnIn: (event.currentTarget as HTMLSelectElement).value as SubtitleBurnIn })}>
                        {SUBTITLE_BURN_IN_CHOICES.map(choice => <option key={choice.value} value={choice.value}>{t(choice.label)}</option>)}
                    </select>
                </label>
                <p class="muted">{t('Image-based subtitles (PGS, DVD, DVB) are always burned in by the server. Burning in styled ASS/SSA keeps their fonts and positioning but requires a server conversion.')}</p>
            </section>}
            {screen === 'taste' && <TasteProfileView profile={taste} />}
            {screen === 'account' && account && <>
                {accountMessage && <p class="notice success" role="status">{accountMessage}</p>}
                <section class="profile-form account-avatar" aria-labelledby="account-avatar-title">
                    <h2 id="account-avatar-title">{t('Profile image')}</h2>
                    {account.PrimaryImageTag
                        ? <img class="account-avatar-image" src={userImageUrl(session.server, account.Id, account.PrimaryImageTag)} alt="" />
                        : <span class="account-avatar-image remembered-user-avatar" style={{ background: profileColor(account.Id) }} aria-hidden="true">{account.Name.slice(0, 1).toUpperCase()}</span>}
                    {hostSupports('fileinput') && <label class="button secondary">{t('Upload image')}<input data-focusable="true" class="visually-hidden" type="file" accept="image/png,image/jpeg,image/webp,image/gif" disabled={saving} onChange={uploadAvatar} /></label>}
                    {account.PrimaryImageTag && <button class="button secondary" data-focusable="true" type="button" disabled={saving} onClick={removeAvatar}>{t('Remove image')}</button>}
                </section>
                <form class="profile-form" onSubmit={changePassword} aria-labelledby="account-password-title">
                    <h2 id="account-password-title">{account.HasPassword === false ? t('Set a password') : t('Change password')}</h2>
                    {account.HasPassword !== false && <label>{t('Current password')}<input data-focusable="true" type="password" autoComplete="current-password" value={passwords.current} onInput={event => setPasswords(old => ({ ...old, current: (event.currentTarget as HTMLInputElement).value }))} /></label>}
                    <label>{t('New password')}<input data-focusable="true" type="password" autoComplete="new-password" value={passwords.next} onInput={event => setPasswords(old => ({ ...old, next: (event.currentTarget as HTMLInputElement).value }))} /></label>
                    <label>{t('Confirm new password')}<input data-focusable="true" type="password" autoComplete="new-password" value={passwords.confirm} onInput={event => setPasswords(old => ({ ...old, confirm: (event.currentTarget as HTMLInputElement).value }))} /></label>
                    <p class="muted">{t('Accounts that sign in with SSO keep using SSO; this password is only used for direct sign-in.')}</p>
                    <button class="button primary" data-focusable="true" type="submit" disabled={saving}>{saving ? t('Saving…') : t('Change password')}</button>
                </form>
            </>}
            {screen === 'home' && <HomeSectionsEditor api={api} userId={session.user.Id} />}
            {screen === 'controls' && <section class="profile-form" aria-labelledby="controls-title">
                <h2 id="controls-title">{t('Controls on this device')}</h2>
                <p>{t('Stored in this browser only. Arrow keys and TV remotes always work.')}</p>
                <label class="profile-checkbox"><input data-focusable="true" type="checkbox" checked={controls.gamepad} onChange={event => updateControls({ gamepad: (event.currentTarget as HTMLInputElement).checked })} />{' '}{t('Use a game controller for navigation (D-pad or left stick moves, A selects, B goes back)')}</label>
                <label>{t('Smooth scrolling')}
                    <select data-focusable="true" value={controls.smoothScroll} onChange={event => updateControls({ smoothScroll: (event.currentTarget as HTMLSelectElement).value as SmoothScrollChoice })}>
                        <option value="auto">{t('Automatic (follow the reduced-motion setting)')}</option>
                        <option value="on">{t('On')}</option>
                        <option value="off">{t('Off')}</option>
                    </select>
                </label>
            </section>}
            {screen === 'display' && <section class="profile-form" aria-labelledby="display-title">
                <h2 id="display-title">{t('Display on this device')}</h2>
                <p>{t('Theme, text size and motion are stored in this browser. Changing the language reloads the page.')}</p>
                <label>{t('Language')}
                    <select data-focusable="true" value={readStoredLanguage(session.user.Id)} onChange={event => changeLanguage((event.currentTarget as HTMLSelectElement).value)}>
                        <option value="">{t('Automatic ({0})', languageName(browserLanguage()))}</option>
                        {LANGUAGE_CHOICES.map(code => <option key={code} value={code}>{languageName(code)}</option>)}
                    </select>
                </label>
                <label>{t('Theme')}
                    <select data-focusable="true" value={display.theme} onChange={event => updateDisplay({ theme: (event.currentTarget as HTMLSelectElement).value as ThemeChoice })}>
                        <option value="dark">{t('Dark')}</option>
                        <option value="light">{t('Light')}</option>
                        <option value="system">{t('Match the system')}</option>
                    </select>
                </label>
                <label>{t('Text size')}
                    <select data-focusable="true" value={String(display.textSize)} onChange={event => updateDisplay({ textSize: Number((event.currentTarget as HTMLSelectElement).value) as TextSize })}>
                        {TEXT_SIZES.map(size => <option key={size} value={String(size)}>{formatNumber(size / 100, { style: 'percent' })}</option>)}
                    </select>
                </label>
                <label class="profile-checkbox"><input data-focusable="true" type="checkbox" checked={display.reducedMotion} onChange={event => updateDisplay({ reducedMotion: (event.currentTarget as HTMLInputElement).checked })} />{' '}{t('Reduce motion')}</label>
            </section>}
        </>}
    </section>;
}

const LANGUAGE_CHOICES = [ 'en-us', ...Object.keys(localeLoaders) ].sort((a, b) => languageName(a).localeCompare(languageName(b)));

function profileColor(userId: string): string {
    const colors = [ '#2379b5', '#b43c52', '#267b79', '#7751b0', '#b2692c', '#477b35' ];
    let hash = 0;
    for (let index = 0; index < userId.length; index++) hash = (hash * 31 + userId.charCodeAt(index)) >>> 0;
    return colors[hash % colors.length];
}

function TasteProfileView({ profile }: { profile: TasteProfile | null }) {
    if (!profile) return null;
    const affinity = [ ...(profile.Tags || []).slice(0, 6), ...(profile.Studios || []).slice(0, 4).map(studio => ({ ...studio, Label: `Studio · ${studio.Label || ''}` })) ];
    return <div class="taste-profile-content">
        <div class="taste-persona"><h2>{profile.Persona?.Title || t('Still calibrating')}</h2><p>{profile.Persona?.Blurb || t('Keep watching and rating titles to build your taste profile.')}</p>
            <div class="taste-summary"><span>{t('{0} titles sampled', profile.SampleCount || 0)}</span>{profile.UpdatedAt && <span>{t('Updated {0}', new Date(profile.UpdatedAt).toLocaleDateString())}</span>}{profile.RatingMean != null && <span>{t('Average rating {0}', profile.RatingMean.toFixed(1))}</span>}</div>
        </div>
        {!!profile.Genres?.length && <section class="taste-section"><h2>{t('Genre focus')}</h2><div class="taste-bars">{profile.Genres.slice(0, 8).map(weight => <TasteBar key={weight.Label} label={weight.Label || t('Unknown')} weight={weight.Weight || 0} max={Math.max(...(profile.Genres || []).map(item => item.Weight || 0), 0.01)} />)}</div></section>}
        {!!affinity.length && <section class="taste-section"><h2>{t('Affinities')}</h2><div class="taste-bars">{affinity.map(weight => <TasteBar key={weight.Label} label={weight.Label || t('Unknown')} weight={weight.Weight || 0} max={Math.max(...affinity.map(item => item.Weight || 0), 0.01)} />)}</div></section>}
        {!!profile.People?.length && <section class="taste-section"><h2>{t('People')}</h2><div class="taste-people">{profile.People.slice(0, 8).map(person => <span key={`${person.Name}-${person.Role}`}>{person.Name}{person.Role ? ` · ${person.Role}` : ''}</span>)}</div></section>}
        {!profile.HasProfile && <p class="profile-status">{t('Your profile is still calibrating. Your viewing activity will gradually build recommendations.')}</p>}
    </div>;
}

function TasteBar({ label, weight, max }: { label: string; weight: number; max: number }) {
    return <div class="taste-bar-row"><span>{t(label)}</span><div class="taste-bar-track"><i style={{ width: `${Math.max(2, weight / max * 100)}%` }} /></div></div>;
}

function messageOf(error: unknown): string {
    return userMessage(error);
}
