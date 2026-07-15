namespace Jellyfin.Plugin.Pgsql.Taste;

/// <summary>
/// Generated persona surface + structured axes.
/// </summary>
/// <param name="Code">Stable axis code.</param>
/// <param name="Title">Display title.</param>
/// <param name="Blurb">Data-grounded subtitle.</param>
/// <param name="Domain">Domain axis key.</param>
/// <param name="Stance">Stance axis key.</param>
/// <param name="Bar">Bar axis key.</param>
/// <param name="Loyalty">Loyalty axis key.</param>
/// <param name="Mood">Mood axis key.</param>
/// <param name="Focus">specialist or omnivore.</param>
public sealed record TastePersonaResult(
    string Code,
    string Title,
    string Blurb,
    string? Domain,
    string? Stance,
    string? Bar,
    string? Loyalty,
    string? Mood,
    string Focus);
