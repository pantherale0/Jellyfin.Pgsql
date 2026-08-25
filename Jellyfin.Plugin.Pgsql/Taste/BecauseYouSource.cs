using System;

namespace Jellyfin.Plugin.Pgsql.Taste;

/// <summary>A chosen Because you X baseline.</summary>
/// <param name="ItemId">Movie id.</param>
/// <param name="Kind"><see cref="BecauseYouSourceKinds"/> value.</param>
public readonly record struct BecauseYouSource(Guid ItemId, string Kind);
