import type { ChannelMappingOptions, ListingsProviderInfo, TunerHostInfo } from './types';
import { t } from '../i18n';

export type TunerType = 'm3u' | 'hdhomerun';
export type ProviderType = 'xmltv' | 'SchedulesDirect';

/** Fields the server only honours for one tuner type; the other type's form never shows them. */
const TUNER_TYPE_FIELDS: Record<TunerType, string[]> = {
    m3u: ['TunerCount', 'UserAgent', 'EnableStreamLooping', 'IgnoreDts', 'ReadAtNativeFramerate', 'AllowFmp4TranscodingContainer', 'AllowStreamSharing'],
    hdhomerun: ['ImportFavoritesOnly', 'AllowHWTranscoding'],
};

export function tunerFieldVisibility(type: string | undefined) {
    const m3u = type === 'm3u';
    const hdhomerun = type === 'hdhomerun';
    return {
        tunerCount: m3u,
        userAgent: m3u,
        streamLooping: m3u,
        ignoreDts: m3u,
        nativeFramerate: m3u,
        fmp4Container: m3u,
        streamSharing: m3u,
        favoritesOnly: hdhomerun,
        hwTranscoding: hdhomerun,
        fallbackBitrate: m3u || hdhomerun,
    };
}

export interface TunerDraft {
    Type: string;
    Url: string;
    FriendlyName: string;
    DeviceId?: string;
    TunerCount: number;
    UserAgent: string;
    FallbackMaxStreamingBitrateMbps: number;
    ImportFavoritesOnly: boolean;
    AllowHWTranscoding: boolean;
    AllowFmp4TranscodingContainer: boolean;
    AllowStreamSharing: boolean;
    EnableStreamLooping: boolean;
    IgnoreDts: boolean;
    ReadAtNativeFramerate: boolean;
}

export function tunerDraftFrom(info: TunerHostInfo | null | undefined, fallbackType = 'm3u'): TunerDraft {
    return {
        Type: info?.Type || fallbackType,
        Url: info?.Url || '',
        FriendlyName: info?.FriendlyName || '',
        DeviceId: info?.DeviceId || undefined,
        TunerCount: info?.TunerCount ?? 0,
        UserAgent: info?.UserAgent || '',
        FallbackMaxStreamingBitrateMbps: info?.FallbackMaxStreamingBitrate ? info.FallbackMaxStreamingBitrate / 1e6 : 30,
        ImportFavoritesOnly: info?.ImportFavoritesOnly === true,
        AllowHWTranscoding: info?.AllowHWTranscoding === true,
        AllowFmp4TranscodingContainer: info?.AllowFmp4TranscodingContainer === true,
        AllowStreamSharing: info?.AllowStreamSharing === true,
        EnableStreamLooping: info?.EnableStreamLooping === true,
        IgnoreDts: info?.IgnoreDts === true,
        ReadAtNativeFramerate: info?.ReadAtNativeFramerate === true,
    };
}

/** Starts from the stored tuner so server-only fields (Source, future options) survive the save. */
export function buildTunerPayload(stored: TunerHostInfo | null | undefined, draft: TunerDraft): TunerHostInfo {
    const payload: TunerHostInfo = {
        ...(stored || {}),
        Type: draft.Type,
        Url: draft.Url.trim(),
        FriendlyName: draft.FriendlyName.trim() || undefined,
        DeviceId: draft.DeviceId || stored?.DeviceId || undefined,
        FallbackMaxStreamingBitrate: Math.round(1e6 * (Number.isFinite(draft.FallbackMaxStreamingBitrateMbps) && draft.FallbackMaxStreamingBitrateMbps > 0 ? draft.FallbackMaxStreamingBitrateMbps : 30)),
        TunerCount: Math.max(0, Math.floor(draft.TunerCount || 0)),
        UserAgent: draft.UserAgent.trim() || undefined,
        ImportFavoritesOnly: draft.ImportFavoritesOnly,
        AllowHWTranscoding: draft.AllowHWTranscoding,
        AllowFmp4TranscodingContainer: draft.AllowFmp4TranscodingContainer,
        AllowStreamSharing: draft.AllowStreamSharing,
        EnableStreamLooping: draft.EnableStreamLooping,
        IgnoreDts: draft.IgnoreDts,
        ReadAtNativeFramerate: draft.ReadAtNativeFramerate,
    };
    for (const [type, fields] of Object.entries(TUNER_TYPE_FIELDS)) {
        if (type === draft.Type) continue;
        for (const field of fields) {
            if (field === 'TunerCount') payload[field] = 0;
            else if (field === 'UserAgent') delete payload[field];
            else payload[field] = false;
        }
    }
    return payload;
}

export function validateTunerDraft(draft: TunerDraft): string | null {
    if (draft.Type !== 'm3u' && draft.Type !== 'hdhomerun') return t('Choose a supported tuner type.');
    if (!draft.Url.trim()) return draft.Type === 'm3u' ? t('Enter the M3U file path or URL.') : t('Enter the tuner IP address or URL.');
    if (!Number.isFinite(draft.TunerCount) || draft.TunerCount < 0) return t('Tuner count must be 0 or more.');
    if (!Number.isFinite(draft.FallbackMaxStreamingBitrateMbps) || draft.FallbackMaxStreamingBitrateMbps <= 0) return t('Fallback bitrate must be greater than 0 Mbps.');
    return null;
}

export interface ProviderDraft {
    Type: string;
    Path: string;
    UserAgent: string;
    MoviePrefix: string;
    MovieCategories: string;
    KidsCategories: string;
    NewsCategories: string;
    SportsCategories: string;
    Username: string;
    Password: string;
    Country: string;
    ZipCode: string;
    ListingsId: string;
    EnableAllTuners: boolean;
    EnabledTuners: string[];
}

export function parseCategories(value: string): string[] {
    return value.split('|').map(part => part.trim()).filter(Boolean);
}

export function providerDraftFrom(info: ListingsProviderInfo | null | undefined, fallbackType = 'xmltv'): ProviderDraft {
    return {
        Type: info?.Type || fallbackType,
        Path: info?.Path || '',
        UserAgent: info?.UserAgent || '',
        MoviePrefix: info?.MoviePrefix || '',
        MovieCategories: (info?.MovieCategories || []).join('|'),
        KidsCategories: (info?.KidsCategories || []).join('|'),
        NewsCategories: (info?.NewsCategories || []).join('|'),
        SportsCategories: (info?.SportsCategories || []).join('|'),
        Username: info?.Username || '',
        Password: '',
        Country: info?.Country || '',
        ZipCode: info?.ZipCode || '',
        ListingsId: info?.ListingsId || '',
        EnableAllTuners: info ? info.EnableAllTuners === true : true,
        EnabledTuners: info?.EnabledTuners || [],
    };
}

/**
 * Builds a provider save from the latest stored copy. Channel mappings are saved by their own endpoint, so
 * they always come from the latest copy rather than the draft. Schedules Direct keeps the stored password
 * unless a new one is typed; the server hashes it when requesting a token, so it is sent in the body.
 */
export function buildProviderPayload(latest: ListingsProviderInfo | null | undefined, draft: ProviderDraft): ListingsProviderInfo {
    const payload: ListingsProviderInfo = {
        ...(latest || {}),
        Type: draft.Type,
        EnableAllTuners: draft.EnableAllTuners,
        EnabledTuners: draft.EnableAllTuners ? [] : draft.EnabledTuners.slice(),
        ChannelMappings: latest?.ChannelMappings || [],
    };
    if (draft.Type === 'xmltv') {
        payload.Path = draft.Path.trim();
        payload.UserAgent = draft.UserAgent.trim() || undefined;
        payload.MoviePrefix = draft.MoviePrefix.trim() || undefined;
        payload.MovieCategories = parseCategories(draft.MovieCategories);
        payload.KidsCategories = parseCategories(draft.KidsCategories);
        payload.NewsCategories = parseCategories(draft.NewsCategories);
        payload.SportsCategories = parseCategories(draft.SportsCategories);
    } else {
        payload.Username = draft.Username.trim();
        if (draft.Password) payload.Password = draft.Password;
        payload.Country = draft.Country || undefined;
        payload.ZipCode = draft.ZipCode.trim() || undefined;
        payload.ListingsId = draft.ListingsId || undefined;
    }
    return payload;
}

export type ProviderValidationStage = 'login' | 'listings';

export function validateProviderDraft(draft: ProviderDraft, stage: ProviderValidationStage, hasStoredPassword: boolean): string | null {
    if (draft.Type === 'xmltv') {
        if (!draft.Path.trim()) return t('Enter the XMLTV file path or URL.');
    } else if (draft.Type === 'SchedulesDirect') {
        if (!draft.Username.trim()) return t('Enter the Schedules Direct username.');
        if (!draft.Password && !hasStoredPassword) return t('Enter the Schedules Direct password.');
        if (stage === 'listings') {
            if (!draft.Country) return t('Choose a country.');
            if (!draft.ZipCode.trim()) return t('Enter a postal code.');
            if (!draft.ListingsId) return t('Choose a lineup.');
        }
    } else {
        return t('Choose a supported guide provider.');
    }
    if (!draft.EnableAllTuners && draft.EnabledTuners.length === 0) return t('Select at least one tuner, or use all tuners.');
    return null;
}

export interface ChannelMappingRow {
    tunerChannelId: string;
    tunerChannelName: string;
    providerChannelId: string;
    providerChannelName: string;
    explicit: boolean;
}

/** Saved mappings win; otherwise the server's own suggestion (usually a number or name match) is shown. */
export function mergeChannelMappings(options: ChannelMappingOptions | null | undefined): ChannelMappingRow[] {
    const mappings = options?.Mappings || [];
    const providerNames = new Map((options?.ProviderChannels || []).filter(c => c.Id).map(c => [c.Id!.toLowerCase(), c.Name || c.Id!]));
    return (options?.TunerChannels || []).filter(channel => channel.Id).map(channel => {
        const saved = mappings.find(pair => (pair.Name || '').toLowerCase() === channel.Id!.toLowerCase());
        const providerChannelId = saved?.Value || channel.ProviderChannelId || '';
        return {
            tunerChannelId: channel.Id!,
            tunerChannelName: channel.Name || channel.Id!,
            providerChannelId,
            providerChannelName: providerChannelId ? providerNames.get(providerChannelId.toLowerCase()) || channel.ProviderChannelName || providerChannelId : '',
            explicit: !!saved,
        };
    });
}

export function schedulesDirectCountries(response: Record<string, Array<{ fullName?: string; shortName?: string }>> | null | undefined): Array<{ name: string; value: string }> {
    const rows: Array<{ name: string; value: string }> = [];
    for (const [region, countries] of Object.entries(response || {})) {
        if (region === 'ZZZ' || !Array.isArray(countries)) continue;
        for (const country of countries) if (country.shortName) rows.push({ name: country.fullName || country.shortName, value: country.shortName });
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/** Binds async loads and saves to one tuner, provider or mapping row so late responses cannot touch another. */
export class ProvisioningLoadTracker {
    private generation = 0;
    private key = '';

    begin(key: string): number {
        this.generation += 1;
        this.key = key;
        return this.generation;
    }

    isCurrent(token: number, key: string): boolean {
        return token === this.generation && key === this.key;
    }

    cancel(): void {
        this.generation += 1;
        this.key = '';
    }
}

export type ProvisioningDraftStatus = 'loading' | 'ready' | 'error';

export function canSaveProvisioningDraft(status: ProvisioningDraftStatus, draftKey: string | undefined, selectedKey: string | undefined, busy: boolean): boolean {
    return status === 'ready' && !busy && draftKey !== undefined && draftKey === selectedKey;
}
