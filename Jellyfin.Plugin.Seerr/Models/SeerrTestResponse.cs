using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.Seerr.Models;

/// <summary>
/// Response for connection test.
/// </summary>
public sealed class SeerrTestResponse
{
    /// <summary>
    /// Gets or sets the Seerr version string when available.
    /// </summary>
    [JsonPropertyName("version")]
    public string? Version { get; set; }

    /// <summary>
    /// Gets or sets a human-readable result message.
    /// </summary>
    [JsonPropertyName("message")]
    public string Message { get; set; } = string.Empty;
}
