using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.Pgsql.Trailers;

/// <summary>
/// Validates canonical YouTube video identifiers.
/// </summary>
internal static partial class YouTubeVideoId
{
    /// <summary>
    /// Determines whether a value is a strict YouTube video identifier.
    /// </summary>
    /// <param name="value">Candidate identifier.</param>
    /// <returns><see langword="true"/> when valid.</returns>
    public static bool IsValid(string value) => VideoIdRegex().IsMatch(value);

    [GeneratedRegex("^[A-Za-z0-9_-]{11}$", RegexOptions.CultureInvariant)]
    private static partial Regex VideoIdRegex();
}
