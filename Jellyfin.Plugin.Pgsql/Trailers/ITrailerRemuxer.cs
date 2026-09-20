using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;

namespace Jellyfin.Plugin.Pgsql.Trailers;

/// <summary>
/// Remuxes adaptive trailer tracks into a browser-compatible response.
/// </summary>
public interface ITrailerRemuxer
{
    /// <summary>
    /// Relays separate video and audio tracks as fragmented MP4.
    /// </summary>
    /// <param name="resolution">Resolved adaptive media tracks.</param>
    /// <param name="context">Current HTTP context.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task representing the relay operation.</returns>
    Task RelayAsync(YtDlpResolution resolution, HttpContext context, CancellationToken cancellationToken);
}
