using System;

namespace Jellyfin.Plugin.Pgsql.Search;

/// <summary>
/// PostgreSQL-mapped helpers for media search. CLR bodies are never executed;
/// EF Core translates calls to SQL functions registered on the model.
/// </summary>
public static class PgSearchDbFunctions
{
    /// <summary>
    /// Returns true when <paramref name="haystack"/> or any whitespace-separated token
    /// is within <paramref name="maxDistance"/> Levenshtein edits of <paramref name="needle"/>.
    /// </summary>
    /// <param name="haystack">Normalized title text.</param>
    /// <param name="needle">Normalized search term.</param>
    /// <param name="maxDistance">Maximum allowed edit distance.</param>
    /// <returns>True when a fuzzy token match exists.</returns>
    public static bool TokenLevenshteinMatch(string? haystack, string needle, int maxDistance)
        => throw new InvalidOperationException("This method is for EF Core SQL translation only.");
}
