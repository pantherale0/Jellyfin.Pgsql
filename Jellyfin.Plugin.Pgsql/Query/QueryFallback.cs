using System;
using System.Data.Common;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Pgsql.Query;

/// <summary>
/// Executes query/cache operations with explicit recoverable-exception handling so that
/// infrastructure failures degrade gracefully without catching unintended exceptions.
/// </summary>
internal static class QueryFallback
{
    /// <summary>
    /// Runs a database-backed operation and returns <c>null</c> on recoverable failures.
    /// </summary>
    /// <typeparam name="T">The result type.</typeparam>
    /// <param name="action">The operation to run.</param>
    /// <param name="logger">The logger.</param>
    /// <param name="message">The warning message.</param>
    /// <param name="onFailure">Optional callback invoked before logging.</param>
    /// <returns>The operation result, or <c>null</c> on recoverable failure.</returns>
    public static T? TryDatabase<T>(Func<T> action, ILogger logger, string message, Action? onFailure = null)
        where T : class
    {
        try
        {
            return action();
        }
        catch (DbException ex)
        {
            return LogAndReturnNull<T>(ex, logger, message, onFailure);
        }
        catch (InvalidOperationException ex)
        {
            return LogAndReturnNull<T>(ex, logger, message, onFailure);
        }
        catch (TimeoutException ex)
        {
            return LogAndReturnNull<T>(ex, logger, message, onFailure);
        }
        catch (ArgumentException ex)
        {
            return LogAndReturnNull<T>(ex, logger, message, onFailure);
        }
        catch (NotSupportedException ex)
        {
            return LogAndReturnNull<T>(ex, logger, message, onFailure);
        }
    }

    private static T? LogAndReturnNull<T>(Exception ex, ILogger logger, string message, Action? onFailure)
        where T : class
    {
        onFailure?.Invoke();
        if (logger.IsEnabled(LogLevel.Warning))
        {
            logger.LogWarning(ex, "{Message}", message);
        }

        return null;
    }
}
