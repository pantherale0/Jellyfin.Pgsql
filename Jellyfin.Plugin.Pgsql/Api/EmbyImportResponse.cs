using Jellyfin.Plugin.Pgsql.Admin.EmbyImport;

namespace Jellyfin.Plugin.Pgsql.Api;

/// <summary>
/// Preview or execute response for Emby UserData import.
/// </summary>
public sealed class EmbyImportResponse
{
    /// <summary>
    /// Gets or sets a value indicating whether this is a preview.
    /// </summary>
    public bool IsPreview { get; set; }

    /// <summary>
    /// Gets or sets the counts.
    /// </summary>
    public required EmbyImportCounts Counts { get; set; }

    /// <summary>
    /// Gets or sets an optional warning message.
    /// </summary>
    public string? Warning { get; set; }
}
