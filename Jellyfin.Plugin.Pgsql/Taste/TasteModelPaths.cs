using System.IO;

namespace Jellyfin.Plugin.Pgsql.Taste;

/// <summary>
/// Shared paths for shadow taste-model artifacts.
/// </summary>
public static class TasteModelPaths
{
    /// <summary>
    /// Resolves the directory that stores <c>taste-shadow-*.zip</c> files.
    /// </summary>
    /// <returns>Absolute directory path.</returns>
    public static string ResolveDirectory()
    {
        var root = Plugin.Instance?.DataFolderPath
            ?? Path.Join(Path.GetTempPath(), "jellyfin-pgsql-taste");
        return Path.Join(root, "taste-models");
    }
}
