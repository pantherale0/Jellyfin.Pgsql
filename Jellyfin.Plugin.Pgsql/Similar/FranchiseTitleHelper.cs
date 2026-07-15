using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.Pgsql.Similar;

/// <summary>
/// Normalizes and tokenizes movie titles for franchise / collection-adjacent matching.
/// </summary>
public static partial class FranchiseTitleHelper
{
    private static readonly HashSet<string> StopWords = new(StringComparer.Ordinal)
    {
        "a", "an", "and", "or", "of", "the", "in", "on", "at", "to", "for", "from",
        "part", "pt", "vol", "volume", "movie", "film", "edition", "version",
        "extended", "directors", "cut", "uncut", "remastered", "theatrical",
    };

    /// <summary>
    /// Minimum token length considered franchise-significant (avoids "man", "me", etc.).
    /// </summary>
    public const int MinSignificantTokenLength = 5;

    /// <summary>
    /// Lowers, strips punctuation / years, and collapses whitespace for title comparison.
    /// </summary>
    /// <param name="title">Raw or cleaned title.</param>
    /// <returns>Normalized title text.</returns>
    public static string NormalizeTitle(string? title)
    {
        if (string.IsNullOrWhiteSpace(title))
        {
            return string.Empty;
        }

        var lower = title.ToLowerInvariant();
        var withoutYears = YearTokenRegex().Replace(lower, " ");
        var sb = new StringBuilder(withoutYears.Length);
        foreach (var ch in withoutYears)
        {
            if (char.IsLetterOrDigit(ch) || char.IsWhiteSpace(ch))
            {
                sb.Append(ch);
            }
            else
            {
                sb.Append(' ');
            }
        }

        var collapsed = WhitespaceRegex().Replace(sb.ToString(), " ").Trim();
        return collapsed;
    }

    /// <summary>
    /// Extracts significant franchise tokens from a title (stop-words and short tokens removed).
    /// </summary>
    /// <param name="title">Raw or cleaned title.</param>
    /// <returns>Significant tokens in encounter order.</returns>
    public static IReadOnlyList<string> ExtractSignificantTokens(string? title)
    {
        var normalized = NormalizeTitle(title);
        if (normalized.Length == 0)
        {
            return [];
        }

        return normalized
            .Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(t => t.Length >= MinSignificantTokenLength && !StopWords.Contains(t))
            .Distinct(StringComparer.Ordinal)
            .ToArray();
    }

    /// <summary>
    /// Returns true when two titles share at least one significant franchise token.
    /// </summary>
    /// <param name="left">First title.</param>
    /// <param name="right">Second title.</param>
    /// <returns>True when a significant token overlaps.</returns>
    public static bool SharesSignificantToken(string? left, string? right)
    {
        var leftTokens = ExtractSignificantTokens(left);
        if (leftTokens.Count == 0)
        {
            return false;
        }

        var rightSet = ExtractSignificantTokens(right).ToHashSet(StringComparer.Ordinal);
        return leftTokens.Any(rightSet.Contains);
    }

    /// <summary>
    /// Converts a word_similarity (0–1) into a discrete franchise score band.
    /// </summary>
    /// <param name="wordSimilarity">pg_trgm word_similarity result.</param>
    /// <returns>Franchise score contribution, or 0 when below the floor.</returns>
    public static int FranchiseScoreFromWordSimilarity(double wordSimilarity)
    {
        if (wordSimilarity < MovieSimilarityWeights.TitleWordSimilarityFloor)
        {
            return 0;
        }

        return (int)Math.Round(
            MovieSimilarityWeights.TitleFranchiseMaxWeight * wordSimilarity,
            MidpointRounding.AwayFromZero);
    }

    [GeneratedRegex(@"\b(19|20)\d{2}\b", RegexOptions.CultureInvariant)]
    private static partial Regex YearTokenRegex();

    [GeneratedRegex(@"\s+", RegexOptions.CultureInvariant)]
    private static partial Regex WhitespaceRegex();
}
