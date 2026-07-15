using System;
using System.Collections.Generic;

namespace Jellyfin.Plugin.Pgsql.Api;

/// <summary>
/// Full taste identity payload for the preferences page.
/// </summary>
public sealed class TasteProfileResponse
{
    /// <summary>Gets or sets a value indicating whether a calibrated profile exists.</summary>
    public bool HasProfile { get; set; }

    /// <summary>Gets or sets sample count.</summary>
    public int SampleCount { get; set; }

    /// <summary>Gets or sets last rebuild time (UTC).</summary>
    public DateTime? UpdatedAt { get; set; }

    /// <summary>Gets or sets the persona.</summary>
    public TastePersonaDto Persona { get; set; } = new();

    /// <summary>Gets or sets top genres.</summary>
    public IReadOnlyList<TasteWeightDto> Genres { get; set; } = [];

    /// <summary>Gets or sets top tags.</summary>
    public IReadOnlyList<TasteWeightDto> Tags { get; set; } = [];

    /// <summary>Gets or sets top studios.</summary>
    public IReadOnlyList<TasteWeightDto> Studios { get; set; } = [];

    /// <summary>Gets or sets top people.</summary>
    public IReadOnlyList<TastePersonDto> People { get; set; } = [];

    /// <summary>Gets or sets rating mean.</summary>
    public float? RatingMean { get; set; }

    /// <summary>Gets or sets rating p25.</summary>
    public float? RatingP25 { get; set; }

    /// <summary>Gets or sets rating p75.</summary>
    public float? RatingP75 { get; set; }

    /// <summary>Gets or sets optional shadow eval footnote.</summary>
    public TasteEvalFootnoteDto? ShadowEval { get; set; }
}
