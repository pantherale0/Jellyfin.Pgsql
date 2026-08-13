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
/// <param name="ProductionYear">Item production year.</param>
/// <param name="RunTimeTicks">Item runtime in ticks.</param>
/// <param name="InheritedParentalRatingValue">Inherited parental rating value.</param>
/// <param name="IsSeries">True when the item is a series.</param>
/// <param name="WriterIds">Writer people IDs.</param>
/// <param name="BoxSetIds">Parent box-set IDs.</param>
/// <param name="OriginalLanguage">ISO original language, if any.</param>
/// <param name="ProductionCountries">Production-country tokens.</param>
public readonly record struct TasteCandidateFeatures(
    IReadOnlyCollection<string> Genres,
    IReadOnlyCollection<string> Tags,
    IReadOnlyCollection<string> Studios,
    IReadOnlyCollection<Guid> DirectorIds,
    IReadOnlyCollection<Guid> ActorIds,
    float? CommunityRating,
    int? ProductionYear = null,
    long? RunTimeTicks = null,
    int? InheritedParentalRatingValue = null,
    bool IsSeries = false,
    IReadOnlyCollection<Guid>? WriterIds = null,
    IReadOnlyCollection<Guid>? BoxSetIds = null,
    string? OriginalLanguage = null,
    IReadOnlyCollection<string>? ProductionCountries = null);
