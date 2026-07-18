using System.Collections.Generic;

namespace Jellyfin.Plugin.Pgsql.Api;

/// <summary>
/// Admin payload for shadow taste-model evaluation history.
/// </summary>
public sealed class TasteShadowEvalResponse
{
    /// <summary>Gets or sets feature-flag status.</summary>
    public TasteShadowEvalStatusDto Status { get; set; } = new();

    /// <summary>Gets or sets the most recent run, or null when none exist.</summary>
    public TasteModelEvalRunDto? Latest { get; set; }

    /// <summary>Gets or sets recent runs newest-first.</summary>
    public IReadOnlyList<TasteModelEvalRunDto> Runs { get; set; } = [];
}
