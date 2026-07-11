using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.Pgsql.PlaybackReportingImport;

/// <summary>
/// Imports playback reporting plugin data into native <see cref="Jellyfin.Database.Implementations.Entities.PlaybackActivity"/>.
/// </summary>
public interface IPlaybackReportingImporter
{
    /// <summary>
    /// Imports playback activity from a SQLite database file.
    /// </summary>
    /// <param name="sqlitePath">Path to <c>playback_reporting.db</c>.</param>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>Import statistics.</returns>
    Task<PlaybackReportingMigrationResult> ImportFromSqliteAsync(string sqlitePath, CancellationToken cancellationToken);

    /// <summary>
    /// Imports playback activity from a plugin TSV export.
    /// </summary>
    /// <param name="tsvPath">Path to the TSV file.</param>
    /// <param name="cancellationToken">The cancellation token.</param>
    /// <returns>Import statistics.</returns>
    Task<PlaybackReportingMigrationResult> ImportFromTsvAsync(string tsvPath, CancellationToken cancellationToken);
}
