using System.Collections.Generic;

namespace Jellyfin.Plugin.Pgsql.Trailers;

/// <summary>
/// A resolved upstream trailer URL and the HTTP headers required to request it.
/// </summary>
/// <param name="Url">The resolved media URL.</param>
/// <param name="Headers">Headers required by the upstream media server.</param>
public sealed record YtDlpResolution(string Url, IReadOnlyDictionary<string, string> Headers);
