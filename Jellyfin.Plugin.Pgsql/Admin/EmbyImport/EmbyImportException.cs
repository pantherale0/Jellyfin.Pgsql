using System;

namespace Jellyfin.Plugin.Pgsql.Admin.EmbyImport;

/// <summary>
/// Raised when an Emby UserData import request is invalid.
/// </summary>
public sealed class EmbyImportException : Exception
{
    /// <summary>
    /// Initializes a new instance of the <see cref="EmbyImportException"/> class.
    /// </summary>
    /// <param name="message">Error message.</param>
    /// <param name="isConflict">Whether the caller should return HTTP 409.</param>
    public EmbyImportException(string message, bool isConflict = false)
        : base(message)
    {
        IsConflict = isConflict;
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="EmbyImportException"/> class.
    /// </summary>
    /// <param name="message">Error message.</param>
    /// <param name="innerException">Inner exception.</param>
    public EmbyImportException(string message, Exception innerException)
        : base(message, innerException)
    {
    }

    /// <summary>
    /// Gets a value indicating whether this error should be returned as HTTP 409 Conflict.
    /// </summary>
    public bool IsConflict { get; }
}
