namespace Jellyfin.Plugin.Seerr.Models;

/// <summary>
/// Public status payload for clients.
/// </summary>
public sealed class SeerrStatusResponse
{
    /// <summary>
    /// Gets or sets a value indicating whether the gateway is enabled and configured.
    /// </summary>
    public bool Enabled { get; set; }
}
