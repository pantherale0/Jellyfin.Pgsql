using System;
using System.Buffers.Binary;
using System.Collections.Generic;

namespace Jellyfin.Plugin.Pgsql.Taste;

/// <summary>
/// Versioned binary codec for cached taste recommendation feeds.
/// Layout: version(1) + count(int32 LE) + entries[guid(16) + score(int32 LE) + tier(byte)].
/// Tier byte: 0=none, 1=high, 2=mid.
/// </summary>
public static class TasteRecommendationPayload
{
    private const byte Version = 1;

    /// <summary>
    /// Serializes ranked recommendations.
    /// </summary>
    /// <param name="items">Ranked items.</param>
    /// <returns>Binary payload.</returns>
    public static byte[] Serialize(IReadOnlyList<TasteMatchItem> items)
    {
        ArgumentNullException.ThrowIfNull(items);
        var buffer = new byte[1 + 4 + (items.Count * (16 + 4 + 1))];
        buffer[0] = Version;
        BinaryPrimitives.WriteInt32LittleEndian(buffer.AsSpan(1, 4), items.Count);
        var offset = 5;
        foreach (var item in items)
        {
            item.ItemId.TryWriteBytes(buffer.AsSpan(offset, 16));
            offset += 16;
            BinaryPrimitives.WriteInt32LittleEndian(buffer.AsSpan(offset, 4), item.Score);
            offset += 4;
            buffer[offset++] = EncodeTier(item.Tier);
        }

        return buffer;
    }

    /// <summary>
    /// Deserializes a payload into ranked recommendations.
    /// </summary>
    /// <param name="payload">Binary payload.</param>
    /// <param name="items">Deserialized items.</param>
    /// <returns><c>true</c> when valid.</returns>
    public static bool TryDeserialize(byte[]? payload, out IReadOnlyList<TasteMatchItem> items)
    {
        items = [];
        if (payload is null || payload.Length < 5 || payload[0] != Version)
        {
            return false;
        }

        var count = BinaryPrimitives.ReadInt32LittleEndian(payload.AsSpan(1, 4));
        if (count < 0 || payload.Length != 5 + (count * 21))
        {
            return false;
        }

        var list = new List<TasteMatchItem>(count);
        var offset = 5;
        for (var i = 0; i < count; i++)
        {
            var id = new Guid(payload.AsSpan(offset, 16));
            offset += 16;
            var score = BinaryPrimitives.ReadInt32LittleEndian(payload.AsSpan(offset, 4));
            offset += 4;
            var tier = DecodeTier(payload[offset++]);
            list.Add(new TasteMatchItem(id, tier, score));
        }

        items = list;
        return true;
    }

    private static byte EncodeTier(string? tier)
    {
        if (string.Equals(tier, "high", StringComparison.OrdinalIgnoreCase))
        {
            return 1;
        }

        if (string.Equals(tier, "mid", StringComparison.OrdinalIgnoreCase))
        {
            return 2;
        }

        return 0;
    }

    private static string DecodeTier(byte value)
        => value switch
        {
            1 => "high",
            2 => "mid",
            _ => string.Empty
        };
}
