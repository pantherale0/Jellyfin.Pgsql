using Jellyfin.Plugin.Pgsql.Admin;

namespace Jellyfin.Plugin.Pgsql.Api;

/// <summary>
/// Response for merge/move preview and execute endpoints.
/// </summary>
public sealed class UserAdminTransferResponse
{
    /// <summary>
    /// Gets or sets a value indicating whether this payload is a dry-run preview.
    /// </summary>
    public bool IsPreview { get; set; }

    /// <summary>
    /// Gets or sets operation counts.
    /// </summary>
    public required UserMergeCounts Counts { get; set; }

    /// <summary>
    /// Gets or sets an optional note about in-memory UserData cache staleness.
    /// </summary>
    public string? Warning { get; set; }
}
