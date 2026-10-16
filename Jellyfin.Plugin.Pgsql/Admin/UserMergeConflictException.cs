using System;

namespace Jellyfin.Plugin.Pgsql.Admin;

/// <summary>
/// Raised when an execute request no longer matches its preview.
/// </summary>
public sealed class UserMergeConflictException : Exception
{
    /// <summary>
    /// Initializes a new instance of the <see cref="UserMergeConflictException"/> class.
    /// </summary>
    /// <param name="message">Safe client-facing conflict message.</param>
    public UserMergeConflictException(string message)
        : base(message)
    {
    }
}
