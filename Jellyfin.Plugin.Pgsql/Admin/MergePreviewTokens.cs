using System;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Jellyfin.Plugin.Pgsql.Admin;

/// <summary>
/// Issues and validates short-lived, administrator-bound tokens for destructive user transfers.
/// </summary>
public sealed class MergePreviewTokens
{
    private static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(10);

    private readonly byte[] _key;
    private readonly TimeProvider _timeProvider;

    /// <summary>
    /// Initializes a new instance of the <see cref="MergePreviewTokens"/> class with a process-local key.
    /// </summary>
    public MergePreviewTokens()
        : this(RandomNumberGenerator.GetBytes(32), TimeProvider.System)
    {
    }

    internal MergePreviewTokens(byte[] key, TimeProvider timeProvider)
    {
        ArgumentNullException.ThrowIfNull(key);
        ArgumentNullException.ThrowIfNull(timeProvider);
        if (key.Length < 32)
        {
            throw new ArgumentException("The signing key must contain at least 32 bytes.", nameof(key));
        }

        _key = (byte[])key.Clone();
        _timeProvider = timeProvider;
    }

    /// <summary>
    /// Creates a token for one preview result and administrator.
    /// </summary>
    /// <param name="administratorId">Authenticated administrator id.</param>
    /// <param name="sourceUserId">Source user id.</param>
    /// <param name="targetUserId">Target user id.</param>
    /// <param name="mode">Transfer mode.</param>
    /// <param name="fingerprint">Preview count fingerprint.</param>
    /// <returns>A signed, short-lived preview token.</returns>
    public string Issue(
        Guid administratorId,
        Guid sourceUserId,
        Guid targetUserId,
        string mode,
        string fingerprint)
    {
        var payload = new MergePreviewTokenPayload(
            administratorId,
            sourceUserId,
            targetUserId,
            mode,
            fingerprint,
            _timeProvider.GetUtcNow().Add(Lifetime).ToUnixTimeSeconds());
        var encodedPayload = Base64UrlEncode(JsonSerializer.SerializeToUtf8Bytes(payload));
        var signature = Sign(encodedPayload);
        return string.Concat(encodedPayload, ".", Base64UrlEncode(signature));
    }

    /// <summary>
    /// Validates a token and returns the preview fingerprint it carries.
    /// </summary>
    /// <param name="token">Preview token.</param>
    /// <param name="administratorId">Authenticated administrator id.</param>
    /// <param name="sourceUserId">Source user id.</param>
    /// <param name="targetUserId">Target user id.</param>
    /// <param name="mode">Transfer mode.</param>
    /// <returns>The signed preview fingerprint.</returns>
    /// <exception cref="UserMergeConflictException">The token is invalid, expired or for another request.</exception>
    public string Validate(
        string token,
        Guid administratorId,
        Guid sourceUserId,
        Guid targetUserId,
        string mode)
    {
        if (string.IsNullOrWhiteSpace(token))
        {
            throw Conflict();
        }

        var parts = token.Split('.', StringSplitOptions.None);
        if (parts.Length != 2)
        {
            throw Conflict();
        }

        byte[] suppliedSignature;
        try
        {
            suppliedSignature = Base64UrlDecode(parts[1]);
        }
        catch (FormatException)
        {
            throw Conflict();
        }

        var expectedSignature = Sign(parts[0]);
        if (suppliedSignature.Length != expectedSignature.Length
            || !CryptographicOperations.FixedTimeEquals(suppliedSignature, expectedSignature))
        {
            throw Conflict();
        }

        MergePreviewTokenPayload? payload;
        try
        {
            payload = JsonSerializer.Deserialize<MergePreviewTokenPayload>(Base64UrlDecode(parts[0]));
        }
        catch (JsonException)
        {
            throw Conflict();
        }
        catch (FormatException)
        {
            throw Conflict();
        }

        if (payload is null
            || payload.AdministratorId != administratorId
            || payload.SourceUserId != sourceUserId
            || payload.TargetUserId != targetUserId
            || !string.Equals(payload.Mode, mode, StringComparison.Ordinal)
            || string.IsNullOrWhiteSpace(payload.Fingerprint)
            || payload.ExpiresUtcSeconds <= _timeProvider.GetUtcNow().ToUnixTimeSeconds())
        {
            throw Conflict();
        }

        return payload.Fingerprint;
    }

    /// <summary>
    /// Computes the stable fingerprint used to detect changes after a preview.
    /// </summary>
    /// <param name="counts">Preview or execution counts.</param>
    /// <returns>A SHA-256 fingerprint.</returns>
    public static string Fingerprint(UserMergeCounts counts)
    {
        ArgumentNullException.ThrowIfNull(counts);
        var value = JsonSerializer.SerializeToUtf8Bytes(new object[]
        {
            counts.UserDataMoved,
            counts.UserDataMerged,
            counts.PlaybackActivityMoved,
            counts.DisplayPreferencesMoved,
            counts.DisplayPreferencesDropped,
            counts.ItemDisplayPreferencesMoved,
            counts.ItemDisplayPreferencesDropped,
            counts.CustomItemDisplayPreferencesMoved,
            counts.CustomItemDisplayPreferencesDropped,
            counts.DevicesMoved,
            counts.DevicesDeactivated,
            counts.PermissionsDropped,
            counts.PreferencesUnioned,
            counts.PreferencesDropped,
            counts.AccessSchedulesDropped,
            counts.ImageInfosDropped,
            counts.ActivityLogsMoved,
            counts.TasteProfileSourceRemoved,
            counts.TasteImpressionsSourceRemoved
        });
        return Convert.ToHexString(SHA256.HashData(value));
    }

    private static UserMergeConflictException Conflict()
        => new("The users changed since the preview. Preview again.");

    private byte[] Sign(string encodedPayload)
        => HMACSHA256.HashData(_key, Encoding.ASCII.GetBytes(encodedPayload));

    private static string Base64UrlEncode(byte[] value)
        => Convert.ToBase64String(value).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static byte[] Base64UrlDecode(string value)
    {
        var padded = value.Replace('-', '+').Replace('_', '/');
        padded = padded.PadRight(padded.Length + ((4 - (padded.Length % 4)) % 4), '=');
        return Convert.FromBase64String(padded);
    }

    private sealed record MergePreviewTokenPayload(
        Guid AdministratorId,
        Guid SourceUserId,
        Guid TargetUserId,
        string Mode,
        string Fingerprint,
        long ExpiresUtcSeconds);
}
