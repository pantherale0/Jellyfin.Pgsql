using System;

namespace Jellyfin.Plugin.Pgsql.Query;

/// <summary>
/// A small key/value cache for query results, storing ordered item ID lists.
/// Implementations must never throw from these methods; failures degrade to cache misses.
/// </summary>
internal interface IQueryResultCache
{
    /// <summary>
    /// Attempts to retrieve a cached ID list.
    /// </summary>
    /// <param name="key">The cache key (without global prefix).</param>
    /// <param name="ids">The cached IDs in their original result order.</param>
    /// <returns><c>true</c> on a cache hit.</returns>
    bool TryGet(string key, out Guid[] ids);

    /// <summary>
    /// Stores an ID list under the given key.
    /// </summary>
    /// <param name="key">The cache key (without global prefix).</param>
    /// <param name="ids">The IDs in result order.</param>
    /// <param name="timeToLive">Absolute expiration relative to now.</param>
    void Set(string key, Guid[] ids, TimeSpan timeToLive);

    /// <summary>
    /// Attempts to retrieve an opaque cached payload.
    /// </summary>
    /// <param name="key">The cache key (without global prefix).</param>
    /// <param name="payload">The cached payload.</param>
    /// <returns><c>true</c> on a cache hit.</returns>
    bool TryGetPayload(string key, out byte[] payload);

    /// <summary>
    /// Stores an opaque payload under the given key.
    /// </summary>
    /// <param name="key">The cache key (without global prefix).</param>
    /// <param name="payload">The payload bytes.</param>
    /// <param name="timeToLive">Absolute expiration relative to now.</param>
    void SetPayload(string key, byte[] payload, TimeSpan timeToLive);

    /// <summary>
    /// Clears all cached query results.
    /// </summary>
    void InvalidateAll();
}

/// <summary>
/// Binary serialization for cached ID lists: a version byte followed by raw 16-byte GUIDs.
/// </summary>
internal static class QueryResultPayload
{
    private const byte Version = 1;

    /// <summary>
    /// Serializes an ID list to the binary payload format.
    /// </summary>
    /// <param name="ids">The IDs to serialize.</param>
    /// <returns>The binary payload.</returns>
    public static byte[] Serialize(Guid[] ids)
    {
        var buffer = new byte[1 + (ids.Length * 16)];
        buffer[0] = Version;
        for (var i = 0; i < ids.Length; i++)
        {
            ids[i].TryWriteBytes(buffer.AsSpan(1 + (i * 16), 16));
        }

        return buffer;
    }

    /// <summary>
    /// Deserializes a binary payload back to an ID list.
    /// </summary>
    /// <param name="payload">The binary payload.</param>
    /// <param name="ids">The deserialized IDs.</param>
    /// <returns><c>false</c> when the payload is malformed or from an unknown version.</returns>
    public static bool TryDeserialize(byte[]? payload, out Guid[] ids)
    {
        ids = [];
        if (payload is null || payload.Length < 1 || payload[0] != Version || (payload.Length - 1) % 16 != 0)
        {
            return false;
        }

        var count = (payload.Length - 1) / 16;
        ids = new Guid[count];
        for (var i = 0; i < count; i++)
        {
            ids[i] = new Guid(payload.AsSpan(1 + (i * 16), 16));
        }

        return true;
    }
}
