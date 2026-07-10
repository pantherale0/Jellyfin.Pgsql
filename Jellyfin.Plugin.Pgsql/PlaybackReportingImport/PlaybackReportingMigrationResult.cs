namespace Jellyfin.Plugin.Pgsql.PlaybackReportingImport;

/// <summary>
/// Result of a playback reporting import run.
/// </summary>
public sealed class PlaybackReportingMigrationResult
{
    /// <summary>
    /// Gets or sets the number of rows imported.
    /// </summary>
    public int Imported { get; set; }

    /// <summary>
    /// Gets or sets the number of rows skipped.
    /// </summary>
    public int Skipped { get; set; }

    /// <summary>
    /// Gets or sets the number of source rows read.
    /// </summary>
    public int SourceRows { get; set; }
}
