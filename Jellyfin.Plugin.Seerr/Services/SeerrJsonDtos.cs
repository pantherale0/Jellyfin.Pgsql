#pragma warning disable CA1812, CA1852 // Instantiated by System.Text.Json
#pragma warning disable SA1402 // File contains multiple internal JSON DTO types
#pragma warning disable SA1649 // File name does not match first type (shared DTO file)

using System.Collections.Generic;

namespace Jellyfin.Plugin.Seerr.Services;

internal sealed class SeerrSearchDto
{
    public List<SeerrSearchResultDto> Results { get; set; } = [];
}

internal sealed class SeerrSearchResultDto
{
    public int Id { get; set; }

    public string? MediaType { get; set; }

    public string? Title { get; set; }

    public string? Name { get; set; }

    public string? Overview { get; set; }

    public string? PosterPath { get; set; }

    public string? ReleaseDate { get; set; }

    public string? FirstAirDate { get; set; }

    public SeerrMediaInfoDto? MediaInfo { get; set; }
}

internal sealed class SeerrMediaInfoDto
{
    public int? Status { get; set; }
}

internal sealed class SeerrMediaRequestDto
{
    public int Id { get; set; }
}

internal sealed class SeerrUserResultsDto
{
    public List<SeerrUserDto> Results { get; set; } = [];
}

#pragma warning restore SA1649
#pragma warning restore SA1402
#pragma warning restore CA1812, CA1852
