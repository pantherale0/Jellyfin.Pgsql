import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { JellyfinApi } from './api';
import type { RememberedUser } from './remembered-users';
import type { JellyfinUser, Session, TasteProfile, UserConfiguration } from './types';

export type ProfileScreenName = 'quickconnect' | 'playback' | 'subtitles' | 'taste' | 'accounts';

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
    const [ languages, setLanguages ] = useState<Array<{ ThreeLetterISOLanguageName: string; DisplayName: string }>>([]);
    const [ code, setCode ] = useState('');
    const [ users, setUsers ] = useState<JellyfinUser[]>([]);
    const [ selectedUserId, setSelectedUserId ] = useState(session.user.Id);
    const [ taste, setTaste ] = useState<TasteProfile | null>(null);
    const accountsRef = useRef<HTMLElement>(null);

    useEffect(() => {
        if (screen !== 'accounts' || loading) return;
        accountsRef.current?.querySelector<HTMLElement>('[data-current-user="true"], .remembered-user')?.focus();
    }, [ screen, loading ]);

    useEffect(() => {
        let active = true;
        setLoading(true);
        setError('');
        if (screen === 'accounts') {
            setLoading(false);
        } else if (screen === 'playback' || screen === 'subtitles') {
            const configRequest = api.getUserConfiguration();
            const languageRequest = screen === 'subtitles' ? api.getCultures() : Promise.resolve([]);
            void Promise.all([ configRequest, languageRequest ]).then(([ nextConfig, nextLanguages ]) => {
                if (!active) return;
                setConfiguration(nextConfig);
                setLanguages(nextLanguages);
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
        setConfiguration(current => ({ ...current, [key]: value }));
    };

    const saveConfiguration = async (event: Event) => {
        event.preventDefault();
        setSaving(true);
        setError('');
        setSaved(false);
        try {
            await api.updateUserConfiguration(configuration);
            setSaved(true);
        } catch (cause) {
            setError(messageOf(cause));
        } finally {
            setSaving(false);
        }
    };

    const authorize = async (event: Event) => {
        event.preventDefault();
        setSaving(true);
        setError('');
        setSaved(false);
        try {
            const accepted = await JellyfinApi.authorizeQuickConnect(session, code, selectedUserId);
            if (!accepted) throw new Error('That Quick Connect code could not be authorized. Check the code and try again.');
            setSaved(true);
            setCode('');
        } catch (cause) {
            setError(messageOf(cause));
        } finally {
            setSaving(false);
        }
    };

    const title = screen === 'accounts' ? 'Switch user' : screen === 'quickconnect' ? 'Quick Connect'
        : screen === 'playback' ? 'Playback preferences'
            : screen === 'subtitles' ? 'Subtitle preferences' : 'Taste profile';

    if (screen === 'quickconnect') return <div class="profile-modal-backdrop" role="presentation" onClick={event => { if (event.target === event.currentTarget) onBack(); }}>
        <section class="profile-modal" role="dialog" aria-modal="true" aria-labelledby="profile-page-title">
            <button class="profile-modal-close" data-focusable="true" type="button" aria-label="Close Quick Connect" onClick={onBack}>×</button>
            <div class="profile-page-heading"><p class="eyebrow">{session.user.Name}</p><h1 id="profile-page-title">Quick Connect</h1></div>
            {loading ? <p class="profile-status" role="status">Loading…</p> : <>
                {error && <p class="notice error" role="alert">{error}</p>}
                {saved && <p class="notice success" role="status">Device authorized.</p>}
                <form class="profile-form" onSubmit={authorize}>
                    <p>Enter the code displayed by the device you want to connect.</p>
                    {isAdministrator && users.length > 0 && <label>Authorize as
                        <select data-focusable="true" value={selectedUserId} onChange={event => setSelectedUserId((event.currentTarget as HTMLSelectElement).value)}>
                            {users.map(user => <option key={user.Id} value={user.Id}>{user.Name}</option>)}
                        </select>
                    </label>}
                    <label>Quick Connect code
                        <input data-focusable="true" value={code} onInput={event => setCode((event.currentTarget as HTMLInputElement).value)} inputMode="numeric" pattern="[0-9\s]*" minLength={6} autoComplete="off" required />
                    </label>
                    <button class="button primary" data-focusable="true" type="submit" disabled={saving}>{saving ? 'Authorizing…' : 'Authorize device'}</button>
                </form>
            </>}
        </section>
    </div>;

    if (screen === 'accounts') return <section ref={accountsRef} class="account-picker" aria-labelledby="profile-page-title">
        <div class="account-picker-content">
            <button class="back-link account-picker-back" data-focusable="true" type="button" onClick={onBack} aria-label="Back to media">← <span>Back</span></button>
            <h1 id="profile-page-title">Who's watching?</h1>
            <p class="account-picker-hint">Choose a profile to continue watching.</p>
            <div class="remembered-users" aria-label="Profiles">
                {rememberedUsers.map(user => <button key={user.userId} data-focusable="true" data-current-user={user.userId === session.user.Id ? 'true' : undefined} class="remembered-user" type="button" onClick={() => onSelectRemembered?.(user)} aria-label={`${user.name}, ${user.session ? 'continue watching' : 'sign in'}${user.userId === session.user.Id ? ', current user' : ''}`}>
                    <span class="remembered-user-avatar" style={{ background: profileColor(user.userId) }} aria-hidden="true">{user.name.slice(0, 1).toUpperCase()}</span>
                    <span class="remembered-user-name">{user.name}</span>
                    <span class="remembered-user-status">{user.userId === session.user.Id ? 'Current user' : user.session ? 'Continue watching' : 'Sign in required'}</span>
                </button>)}
                <button data-focusable="true" class="remembered-user remembered-user-add" type="button" onClick={onSignInAnother} aria-label="Sign in as another user">
                    <span class="remembered-user-avatar" aria-hidden="true">+</span><span class="remembered-user-name">Another user</span><span class="remembered-user-status">Sign in</span>
                </button>
            </div>
        </div>
    </section>;

    return <section class="profile-page" aria-labelledby="profile-page-title">
        <div class="profile-page-heading">
            <button class="back-link" data-focusable="true" type="button" onClick={onBack}>← <span>Back</span></button>
            <p class="eyebrow">{session.user.Name}</p>
            <h1 id="profile-page-title">{title}</h1>
        </div>
        {loading ? <p class="profile-status" role="status">Loading…</p> : <>
            {error && <p class="notice error" role="alert">{error}</p>}
            {saved && <p class="notice success" role="status">Preferences saved.</p>}
            {screen === 'playback' && <form class="profile-form" onSubmit={saveConfiguration}>
                <label>Preferred audio language<input data-focusable="true" value={configuration.AudioLanguagePreference || ''} onInput={event => updateConfiguration('AudioLanguagePreference', (event.currentTarget as HTMLInputElement).value)} placeholder="Any language" /></label>
                <label class="profile-checkbox"><input data-focusable="true" type="checkbox" checked={configuration.PlayDefaultAudioTrack === true} onChange={event => updateConfiguration('PlayDefaultAudioTrack', (event.currentTarget as HTMLInputElement).checked)} /> Prefer default audio track</label>
                <label class="profile-checkbox"><input data-focusable="true" type="checkbox" checked={configuration.RememberAudioSelections === true} onChange={event => updateConfiguration('RememberAudioSelections', (event.currentTarget as HTMLInputElement).checked)} /> Remember audio track selections</label>
                <label class="profile-checkbox"><input data-focusable="true" type="checkbox" checked={configuration.RememberSubtitleSelections === true} onChange={event => updateConfiguration('RememberSubtitleSelections', (event.currentTarget as HTMLInputElement).checked)} /> Remember subtitle track selections</label>
                <label class="profile-checkbox"><input data-focusable="true" type="checkbox" checked={configuration.EnableNextEpisodeAutoPlay !== false} onChange={event => updateConfiguration('EnableNextEpisodeAutoPlay', (event.currentTarget as HTMLInputElement).checked)} /> Automatically play the next episode</label>
                <button class="button primary" data-focusable="true" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save playback preferences'}</button>
            </form>}
            {screen === 'subtitles' && <form class="profile-form" onSubmit={saveConfiguration}>
                <label>Preferred subtitle language
                    <select data-focusable="true" value={configuration.SubtitleLanguagePreference || ''} onChange={event => updateConfiguration('SubtitleLanguagePreference', (event.currentTarget as HTMLSelectElement).value)}>
                        <option value="">Any language</option>
                        <option value="OriginalLanguage">Original language</option>
                        {languages.map(language => <option key={language.ThreeLetterISOLanguageName} value={language.ThreeLetterISOLanguageName}>{language.DisplayName}</option>)}
                    </select>
                </label>
                <label>Subtitle mode
                    <select data-focusable="true" value={String(configuration.SubtitleMode ?? 'Default')} onChange={event => updateConfiguration('SubtitleMode', (event.currentTarget as HTMLSelectElement).value)}>
                        <option value="Default">Default</option><option value="Smart">Smart</option><option value="OnlyForced">Forced only</option><option value="Always">Always play</option><option value="None">None</option>
                    </select>
                </label>
                <button class="button primary" data-focusable="true" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save subtitle preferences'}</button>
            </form>}
            {screen === 'taste' && <TasteProfileView profile={taste} />}
        </>}
    </section>;
}

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
        <div class="taste-persona"><h2>{profile.Persona?.Title || 'Still calibrating'}</h2><p>{profile.Persona?.Blurb || 'Keep watching and rating titles to build your taste profile.'}</p>
            <div class="taste-summary"><span>{profile.SampleCount || 0} titles sampled</span>{profile.UpdatedAt && <span>Updated {new Date(profile.UpdatedAt).toLocaleDateString()}</span>}{profile.RatingMean != null && <span>Average rating {profile.RatingMean.toFixed(1)}</span>}</div>
        </div>
        {!!profile.Genres?.length && <section class="taste-section"><h2>Genre focus</h2><div class="taste-bars">{profile.Genres.slice(0, 8).map(weight => <TasteBar key={weight.Label} label={weight.Label || 'Unknown'} weight={weight.Weight || 0} max={Math.max(...(profile.Genres || []).map(item => item.Weight || 0), 0.01)} />)}</div></section>}
        {!!affinity.length && <section class="taste-section"><h2>Affinities</h2><div class="taste-bars">{affinity.map(weight => <TasteBar key={weight.Label} label={weight.Label || 'Unknown'} weight={weight.Weight || 0} max={Math.max(...affinity.map(item => item.Weight || 0), 0.01)} />)}</div></section>}
        {!!profile.People?.length && <section class="taste-section"><h2>People</h2><div class="taste-people">{profile.People.slice(0, 8).map(person => <span key={`${person.Name}-${person.Role}`}>{person.Name}{person.Role ? ` · ${person.Role}` : ''}</span>)}</div></section>}
        {!profile.HasProfile && <p class="profile-status">Your profile is still calibrating. Your viewing activity will gradually build recommendations.</p>}
    </div>;
}

function TasteBar({ label, weight, max }: { label: string; weight: number; max: number }) {
    return <div class="taste-bar-row"><span>{label}</span><div class="taste-bar-track"><i style={{ width: `${Math.max(2, weight / max * 100)}%` }} /></div></div>;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}
