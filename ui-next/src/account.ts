import { t } from './i18n';
export const AVATAR_TYPES = [ 'image/png', 'image/jpeg', 'image/webp', 'image/gif' ];
export const AVATAR_MAX_BYTES = 10 * 1024 * 1024;

export function validateAvatar(file: { type: string; size: number }): string {
    if (!AVATAR_TYPES.includes(file.type)) return t('Choose a PNG, JPEG, WebP or GIF image.');
    if (file.size > AVATAR_MAX_BYTES) return t('The image must be 10 MB or smaller.');
    return '';
}

/** `data:image/png;base64,AAAA` → `AAAA`; Jellyfin's image upload reads a base64 body. */
export function base64FromDataUrl(dataUrl: string): string {
    const comma = dataUrl.indexOf(',');
    return comma >= 0 && /;base64$/.test(dataUrl.slice(0, comma)) ? dataUrl.slice(comma + 1) : '';
}

export function validatePasswordChange(current: string, next: string, confirm: string, hasPassword: boolean): string {
    if (hasPassword && !current) return t('Enter your current password.');
    if (!next) return t('Enter a new password.');
    if (next !== confirm) return t('The new passwords do not match.');
    if (hasPassword && next === current) return t('The new password must be different from the current one.');
    return '';
}

export interface ForgotPasswordResult { Action?: string; PinFile?: string; PinExpirationDate?: string }

export function forgotPasswordOutcome(result: ForgotPasswordResult, now = Date.now()): { message: string; askPin: boolean } {
    if (result.Action === 'PinCode') {
        const expires = Date.parse(result.PinExpirationDate || '');
        const minutes = Number.isFinite(expires) ? Math.max(0, Math.round((expires - now) / 60000)) : 0;
        return { message: t('The server created a reset PIN. Ask your administrator for it{0}, then enter it below.', minutes ? `; it expires in about ${minutes} minutes` : ''), askPin: true };
    }
    if (result.Action === 'InNetworkRequired') return { message: t('Password reset is only available from the server’s home network. Try again from there or contact your administrator.'), askPin: false };
    return { message: t('Contact your server administrator to reset your password.'), askPin: false };
}

export function pinRedeemMessage(result: { Success?: boolean; UsersReset?: string[] }): { ok: boolean; message: string } {
    if (!result.Success || !result.UsersReset?.length) return { ok: false, message: t('That PIN was not accepted. Check it and try again, or request a new one.') };
    return { ok: true, message: t('Password reset for {0}. Sign in using the PIN as your password, then change it from Account.', result.UsersReset.join(', ')) };
}

export interface PublicUser { Id: string; Name: string; HasPassword: boolean; PrimaryImageTag?: string }

export function publicUsers(raw: unknown): PublicUser[] {
    if (!Array.isArray(raw)) return [];
    return raw.flatMap(entry => {
        if (!entry || typeof entry !== 'object') return [];
        const value = entry as Record<string, unknown>;
        if (typeof value.Id !== 'string' || typeof value.Name !== 'string' || !value.Name) return [];
        return [ { Id: value.Id, Name: value.Name, HasPassword: value.HasPassword !== false, PrimaryImageTag: typeof value.PrimaryImageTag === 'string' ? value.PrimaryImageTag : undefined } ];
    }).slice(0, 50);
}

export function userImageUrl(server: string, userId: string, tag?: string, size = 160): string {
    const params = new URLSearchParams({ userId, maxHeight: String(size), quality: '90' });
    if (tag) params.set('tag', tag);
    return `${server.replace(/\/+$/, '')}/UserImage?${params}`;
}
