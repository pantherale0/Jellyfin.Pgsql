using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.Pgsql.Configuration;

/// <summary>
/// Plugin configuration for PostgreSQL database provider.
/// </summary>
public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>
    /// Initializes a new instance of the <see cref="PluginConfiguration"/> class.
    /// </summary>
    public PluginConfiguration()
    {
        // Configuration is handled via environment variables
        // This class is kept minimal for plugin framework compatibility
    }
}
