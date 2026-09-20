using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.Pgsql.Trailers;

/// <summary>
/// Resolves a YouTube video to a directly streamable media resource.
/// </summary>
public interface IYtDlpProcessRunner
{
    /// <summary>
    /// Resolves a YouTube video.
    /// </summary>
    /// <param name="executablePath">The yt-dlp executable path.</param>
    /// <param name="videoId">The validated YouTube video identifier.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The resolved media resource.</returns>
    Task<YtDlpResolution> ResolveAsync(string executablePath, string videoId, CancellationToken cancellationToken);
}
