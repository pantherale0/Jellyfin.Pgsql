using System;

namespace Jellyfin.Plugin.Pgsql.Trailers;

/// <summary>
/// Resolved yt-dlp trailer options.
/// </summary>
internal sealed class YtDlpOptions
{
    private static readonly Lazy<YtDlpOptions> LazyCurrent = new(Resolve);

    public static YtDlpOptions Current => LazyCurrent.Value;

    public string ExecutablePath { get; private init; } = "yt-dlp";

    private static YtDlpOptions Resolve()
        => new()
        {
            ExecutablePath = Environment.GetEnvironmentVariable("Pgsql_YTDLP_PATH")
                ?? Plugin.Instance?.Configuration.YtDlpPath
                ?? "yt-dlp"
        };
}
