using System.Collections.Generic;

namespace Jellyfin.Plugin.Pgsql.Trailers;

/// <summary>
/// A resolved upstream trailer URL and the HTTP headers required to request it.
/// </summary>
/// <param name="Url">The resolved media URL.</param>
/// <param name="Headers">Headers required by the upstream media server.</param>
/// <param name="AudioUrl">Optional separate adaptive audio URL.</param>
/// <param name="AudioHeaders">Headers required by the adaptive audio server.</param>
public sealed record YtDlpResolution(
    string Url,
    IReadOnlyDictionary<string, string> Headers,
    string? AudioUrl = null,
    IReadOnlyDictionary<string, string>? AudioHeaders = null)
{
    /// <summary>
    /// Gets a value indicating whether separate video and audio inputs must be remuxed.
    /// </summary>
    public bool RequiresRemux => AudioUrl is not null;
}
