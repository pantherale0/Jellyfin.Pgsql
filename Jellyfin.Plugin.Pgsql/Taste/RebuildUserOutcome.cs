namespace Jellyfin.Plugin.Pgsql.Taste;

/// <summary>
/// Outcome of rebuilding one user's taste profile.
/// </summary>
/// <param name="Upserted">Whether a profile row was written.</param>
/// <param name="MovieSignalCount">Distinct movie items with a positive taste signal.</param>
public readonly record struct RebuildUserOutcome(bool Upserted, int MovieSignalCount);
