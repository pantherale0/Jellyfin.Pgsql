using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Pgsql.Query;

/// <summary>
/// Invalidates query caches when library items or user playback state change.
/// </summary>
internal sealed class QueryCacheInvalidationService : IHostedService
{
    private readonly ILibraryManager _libraryManager;
    private readonly IUserDataManager _userDataManager;
    private readonly IQueryResultCache _cache;
    private readonly ILogger<QueryCacheInvalidationService> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="QueryCacheInvalidationService"/> class.
    /// </summary>
    /// <param name="libraryManager">The library manager.</param>
    /// <param name="userDataManager">The user data manager.</param>
    /// <param name="cache">The query result cache.</param>
    /// <param name="logger">The logger.</param>
    public QueryCacheInvalidationService(
        ILibraryManager libraryManager,
        IUserDataManager userDataManager,
        IQueryResultCache cache,
        ILogger<QueryCacheInvalidationService> logger)
    {
        _libraryManager = libraryManager;
        _userDataManager = userDataManager;
        _cache = cache;
        _logger = logger;
    }

    /// <inheritdoc />
    public Task StartAsync(CancellationToken cancellationToken)
    {
        _libraryManager.ItemAdded += OnLibraryChanged;
        _libraryManager.ItemUpdated += OnLibraryChanged;
        _libraryManager.ItemRemoved += OnLibraryChanged;
        _userDataManager.UserDataSaved += OnUserDataSaved;
        return Task.CompletedTask;
    }

    /// <inheritdoc />
    public Task StopAsync(CancellationToken cancellationToken)
    {
        _libraryManager.ItemAdded -= OnLibraryChanged;
        _libraryManager.ItemUpdated -= OnLibraryChanged;
        _libraryManager.ItemRemoved -= OnLibraryChanged;
        _userDataManager.UserDataSaved -= OnUserDataSaved;
        return Task.CompletedTask;
    }

    private void OnLibraryChanged(object? sender, ItemChangeEventArgs e) => InvalidateCaches("library change");

    private void OnUserDataSaved(object? sender, UserDataSaveEventArgs e) => InvalidateCaches("user data save");

    private void InvalidateCaches(string reason)
    {
        try
        {
            _cache.InvalidateAll();
            if (_logger.IsEnabled(LogLevel.Debug))
            {
                _logger.LogDebug("Invalidated PostgreSQL query caches due to {Reason}", reason);
            }
        }
        catch (Exception ex) when (ex is InvalidOperationException or ObjectDisposedException or IOException or TimeoutException)
        {
            _logger.LogWarning(ex, "Failed to invalidate PostgreSQL query caches after {Reason}", reason);
        }
    }
}
