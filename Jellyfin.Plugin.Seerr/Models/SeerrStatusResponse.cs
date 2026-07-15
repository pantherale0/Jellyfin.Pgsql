using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.Seerr.Models;

/// <summary>
/// Public status payload for clients.
/// </summary>
public sealed class SeerrStatusResponse
{
    /// <summary>
    /// Gets or sets a value indicating whether the gateway is enabled and configured.
    /// </summary>
    [JsonPropertyName("enabled")]
    public bool Enabled { get; set; }
}
