using System;

namespace Jellyfin.Plugin.Pgsql.Admin;

/// <summary>
/// Raised when a user merge/move request is invalid.
/// </summary>
public sealed class UserMergeException : Exception
{
    /// <summary>
    /// Initializes a new instance of the <see cref="UserMergeException"/> class.
    /// </summary>
    /// <param name="message">Error message.</param>
    public UserMergeException(string message)
        : base(message)
    {
    }

    /// <summary>
    /// Initializes a new instance of the <see cref="UserMergeException"/> class.
    /// </summary>
    /// <param name="message">Error message.</param>
    /// <param name="innerException">Inner exception.</param>
    public UserMergeException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}
