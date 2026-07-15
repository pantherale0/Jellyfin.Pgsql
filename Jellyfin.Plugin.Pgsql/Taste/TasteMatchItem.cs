using System;

namespace Jellyfin.Plugin.Pgsql.Taste;

/// <summary>
/// A sparse taste match for card badges.
/// </summary>
/// <param name="ItemId">Item id.</param>
/// <param name="Tier">high or mid.</param>
/// <param name="Score">Raw taste bonus.</param>
public sealed record TasteMatchItem(Guid ItemId, string Tier, int Score);
