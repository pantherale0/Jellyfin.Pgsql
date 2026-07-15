namespace Jellyfin.Plugin.Pgsql.Taste;

/// <summary>
/// Openers, commit lines, and closers for a domain genre.
/// </summary>
/// <param name="Openers">Hooks with {n} film count placeholder.</param>
/// <param name="CommitLines">Stance punch lines.</param>
/// <param name="Closers">Optional closing vibes.</param>
internal readonly record struct TastePersonaVibePack(string[] Openers, string[] CommitLines, string[] Closers);
