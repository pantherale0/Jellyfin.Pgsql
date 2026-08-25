using System;
using System.Collections.Generic;

namespace Jellyfin.Plugin.Pgsql.Taste;

/// <summary>A movie eligible to become a Because you X baseline.</summary>
/// <param name="ItemId">Movie id.</param>
/// <param name="BoxSetIds">BoxSet parent ids, if any.</param>
public readonly record struct BecauseYouSourceCandidate(Guid ItemId, IReadOnlyList<Guid> BoxSetIds);
