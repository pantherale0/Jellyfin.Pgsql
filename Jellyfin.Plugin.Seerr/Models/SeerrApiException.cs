using System;

namespace Jellyfin.Plugin.Seerr.Models;

/// <summary>
/// Exception thrown when Seerr returns an actionable client error.
/// </summary>
public sealed class SeerrApiException : Exception
{
    /// <summary>
    /// Initializes a new instance of the <see cref="SeerrApiException"/> class.
    /// </summary>
    /// <param name="statusCode">HTTP status from Seerr.</param>
    /// <param name="message">Readable message.</param>
    public SeerrApiException(int statusCode, string message)
        : base(message)
    {
        StatusCode = statusCode;
    }

    /// <summary>
    /// Gets the HTTP status code from Seerr.
    /// </summary>
    public int StatusCode { get; }
}
