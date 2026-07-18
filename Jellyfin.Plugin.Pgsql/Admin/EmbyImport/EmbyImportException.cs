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
    public EmbyImportException(string message)
        : base(message)
    {
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
}
