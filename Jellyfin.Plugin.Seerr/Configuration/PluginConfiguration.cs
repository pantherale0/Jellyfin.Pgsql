using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.Seerr.Configuration;

/// <summary>
/// Plugin configuration for the Seerr request gateway.
/// </summary>
public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>
    /// Gets or sets a value indicating whether the Seerr gateway is enabled.
    /// </summary>
    public bool Enabled { get; set; }

    /// <summary>
    /// Gets or sets the Seerr base URL (for example <c>https://seerr.example.com</c>).
    /// </summary>
    public string SeerrUrl { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets the Seerr API key. Kept server-side only.
    /// </summary>
    public string ApiKey { get; set; } = string.Empty;

    /// <summary>
    /// Gets or sets a value indicating whether titles already available in Seerr
    /// are omitted from search results. Defaults to <c>true</c>.
    /// </summary>
    public bool HideAvailable { get; set; } = true;

    /// <summary>
    /// Gets or sets the maximum number of requestable search results to return.
    /// </summary>
    public int SearchLimit { get; set; } = 20;
}
