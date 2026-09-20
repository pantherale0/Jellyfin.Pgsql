using System;

namespace Jellyfin.Plugin.Pgsql.Trailers;

/// <summary>
/// Represents a safe yt-dlp resolution failure.
/// </summary>
public sealed class YtDlpException : Exception
{
    /// <summary>
    /// Initializes a new instance of the <see cref="YtDlpException"/> class.
    /// </summary>
    /// <param name="message">Error message.</param>
    public YtDlpException(string message)
        : base(message)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="YtDlpException"/> class.
    /// </summary>
    /// <param name="message">Error message.</param>
    /// <param name="innerException">Underlying exception.</param>
    public YtDlpException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}
