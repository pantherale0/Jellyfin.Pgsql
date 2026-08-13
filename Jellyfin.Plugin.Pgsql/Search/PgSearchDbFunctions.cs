using System;
using Microsoft.EntityFrameworkCore;

namespace Jellyfin.Plugin.Pgsql.Search;

/// <summary>
/// PostgreSQL-mapped helpers for media search. CLR bodies are never executed;
/// EF Core translates calls to SQL functions registered on the model.
/// Prefer these over <c>EF.Functions.Trigrams*</c>/<c>ILike</c>: Npgsql's extension methods
/// do not translate reliably when the plugin ALC and host EF assemblies differ.
/// </summary>
public static class PgSearchDbFunctions
{
    /// <summary>
    /// Returns true when <paramref name="haystack"/> or any whitespace-separated token
    /// is within <paramref name="maxDistance"/> Levenshtein edits of <paramref name="needle"/>.
    /// The SQL implementation lowercases and strips punctuation itself, so mixed-case
    /// OriginalTitle values are safe to pass without a CLR <c>ToLower()</c>.
    /// </summary>
    /// <param name="haystack">Title or value text (any casing).</param>
    /// <param name="needle">Normalized (already lowercased) search term.</param>
    /// <param name="maxDistance">Maximum allowed edit distance.</param>
    /// <returns>True when a fuzzy token match exists.</returns>
    [DbFunction("jellyfin_token_levenshtein_match")]
    public static bool TokenLevenshteinMatch(string? haystack, string needle, int maxDistance)
        => throw new InvalidOperationException("This method is for EF Core SQL translation only.");

    /// <summary>
    /// pg_trgm <c>word_similarity(source, target)</c>.
    /// </summary>
    /// <param name="source">Needle / query fragment.</param>
    /// <param name="target">Haystack title or value.</param>
    /// <returns>Similarity in 0–1.</returns>
    [DbFunction("word_similarity")]
    public static double WordSimilarity(string source, string? target)
        => throw new InvalidOperationException("This method is for EF Core SQL translation only.");

    /// <summary>
    /// Indexable pg_trgm <c>&lt;%</c> (word-similarity) operator. Uses
    /// <c>pg_trgm.word_similarity_threshold</c>; set that with
    /// <see cref="PgTrgmThresholdScope"/> before executing the query.
    /// </summary>
    /// <param name="source">Needle / query fragment.</param>
    /// <param name="target">Haystack title or value.</param>
    /// <returns>True when word similarity meets the session threshold.</returns>
    [DbFunction("jellyfin_word_similar")]
    public static bool IsWordSimilar(string source, string? target)
        => throw new InvalidOperationException("This method is for EF Core SQL translation only.");

    /// <summary>
    /// pg_trgm <c>similarity(source, target)</c>.
    /// </summary>
    /// <param name="source">Haystack.</param>
    /// <param name="target">Needle.</param>
    /// <returns>Similarity in 0–1.</returns>
    [DbFunction("similarity")]
    public static double TrigramSimilarity(string? source, string target)
        => throw new InvalidOperationException("This method is for EF Core SQL translation only.");

    /// <summary>
    /// Case-insensitive LIKE with backslash escape (<c>jellyfin_ilike</c>).
    /// </summary>
    /// <param name="haystack">Text to match.</param>
    /// <param name="pattern">LIKE pattern (may include <c>%</c>/<c>_</c>).</param>
    /// <returns>True when the pattern matches.</returns>
    [DbFunction("jellyfin_ilike")]
    public static bool ILike(string? haystack, string pattern)
        => throw new InvalidOperationException("This method is for EF Core SQL translation only.");
}
