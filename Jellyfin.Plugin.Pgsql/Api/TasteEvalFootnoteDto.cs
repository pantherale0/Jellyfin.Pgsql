using System;

namespace Jellyfin.Plugin.Pgsql.Api;

/// <summary>
/// Latest shadow training footnote.
/// </summary>
public sealed class TasteEvalFootnoteDto
{
    /// <summary>Gets or sets AUC.</summary>
    public double? Auc { get; set; }

    /// <summary>Gets or sets created time UTC.</summary>
    public DateTime CreatedAt { get; set; }
}
