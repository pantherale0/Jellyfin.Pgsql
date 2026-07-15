namespace Jellyfin.Plugin.Pgsql.Taste;

/// <summary>
/// Optional resolved affinity labels for persona blurbs.
/// </summary>
/// <param name="TopTag">Top tag clean value when strong enough.</param>
/// <param name="TopStudio">Top studio clean value when strong enough.</param>
/// <param name="TopPersonName">Resolved people display name when loyalty is high.</param>
/// <param name="TopPersonRole">director or actor.</param>
public sealed record TasteAffinityHints(
    string? TopTag = null,
    string? TopStudio = null,
    string? TopPersonName = null,
    string? TopPersonRole = null);
