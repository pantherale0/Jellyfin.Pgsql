namespace Jellyfin.Plugin.Pgsql.Taste;

/// <summary>
/// Outcome of rebuilding one user's taste profile.
/// </summary>
/// <param name="Upserted">Whether a profile row was written.</param>
/// <param name="MediaSignalCount">Distinct movie + series items with a positive taste signal.</param>
/// <param name="MovieSignalCount">Distinct movie items with a positive taste signal.</param>
/// <param name="SeriesSignalCount">Distinct series items with a positive taste signal.</param>
public readonly record struct RebuildUserOutcome(
    bool Upserted,
    int MediaSignalCount,
    int MovieSignalCount = 0,
    int SeriesSignalCount = 0);
