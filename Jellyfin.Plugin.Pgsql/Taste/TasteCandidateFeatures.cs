using System;
using System.Collections.Generic;

namespace Jellyfin.Plugin.Pgsql.Taste;

/// <summary>
/// Candidate item features used by <see cref="LinearTasteScorer"/>.
/// </summary>
/// <param name="Genres">Genre clean values.</param>
/// <param name="Tags">Tag clean values.</param>
/// <param name="Studios">Studio clean values.</param>
/// <param name="DirectorIds">Director people IDs.</param>
/// <param name="ActorIds">Actor people IDs.</param>
/// <param name="CommunityRating">Item community rating.</param>
public readonly record struct TasteCandidateFeatures(
    IReadOnlyCollection<string> Genres,
    IReadOnlyCollection<string> Tags,
    IReadOnlyCollection<string> Studios,
    IReadOnlyCollection<Guid> DirectorIds,
    IReadOnlyCollection<Guid> ActorIds,
    float? CommunityRating);
