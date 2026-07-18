using System;
using System.Collections.Generic;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Pgsql.Admin.EmbyImport;

/// <summary>
/// Builds an Emby userdata key → Jellyfin item id index from the live library.
/// </summary>
public sealed class EmbyUserDataMatcher
{
    private readonly ILibraryManager _libraryManager;
    private readonly ILogger<EmbyUserDataMatcher> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="EmbyUserDataMatcher"/> class.
    /// </summary>
    /// <param name="libraryManager">Library manager.</param>
    /// <param name="logger">Logger.</param>
    public EmbyUserDataMatcher(ILibraryManager libraryManager, ILogger<EmbyUserDataMatcher> logger)
    {
        _libraryManager = libraryManager;
        _logger = logger;
    }

    /// <summary>
    /// Builds a dictionary mapping userdata keys to Jellyfin item ids.
    /// </summary>
    /// <returns>Key index (first item wins per key).</returns>
    public IReadOnlyDictionary<string, Guid> BuildKeyIndex()
    {
        var items = _libraryManager.GetItemList(new InternalItemsQuery
        {
            Recursive = true,
            IsVirtualItem = false,
        });

        var index = new Dictionary<string, Guid>(StringComparer.OrdinalIgnoreCase);
        foreach (var item in items)
        {
            List<string> keys;
            try
            {
                keys = item.GetUserDataKeys();
            }
            catch (Exception ex) when (ex is InvalidOperationException or ArgumentException or NotSupportedException)
            {
                if (_logger.IsEnabled(LogLevel.Debug))
                {
                    _logger.LogDebug(ex, "Skipping GetUserDataKeys for item {ItemId}", item.Id);
                }

                continue;
            }

            foreach (var key in keys)
            {
                if (string.IsNullOrWhiteSpace(key))
                {
                    continue;
                }

                index.TryAdd(key, item.Id);
            }
        }

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation(
                "Built Emby import key index with {KeyCount} keys from {ItemCount} library items",
                index.Count,
                items.Count);
        }

        return index;
    }

    /// <summary>
    /// Resolves a library item by id.
    /// </summary>
    /// <param name="itemId">Item id.</param>
    /// <returns>The item, or null.</returns>
    public BaseItem? GetItem(Guid itemId) => _libraryManager.GetItemById(itemId);
}
