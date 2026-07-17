using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Claims;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations;
using Jellyfin.Plugin.Pgsql.Taste;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Jellyfin.Plugin.Pgsql.Api;

/// <summary>
/// Exposes taste identity and match APIs for the web UI.
/// </summary>
[ApiController]
[Authorize]
[Route("Pgsql/Taste")]
public sealed class TasteProfileController : ControllerBase
{
    private const string UserIdClaim = "Jellyfin-UserId";
    private const string AdministratorRole = "Administrator";

    private readonly IDbContextFactory<JellyfinDbContext> _dbProvider;
    private readonly TastePersonaGenerator _personaGenerator;
    private readonly TasteMatchService _matchService;
    private readonly TasteRecommendationService _recommendationService;

    /// <summary>
    /// Initializes a new instance of the <see cref="TasteProfileController"/> class.
    /// </summary>
    /// <param name="dbProvider">Database context factory.</param>
    /// <param name="personaGenerator">Persona generator.</param>
    /// <param name="matchService">Match service.</param>
    /// <param name="recommendationService">Recommendation feed service.</param>
    public TasteProfileController(
        IDbContextFactory<JellyfinDbContext> dbProvider,
        TastePersonaGenerator personaGenerator,
        TasteMatchService matchService,
        TasteRecommendationService recommendationService)
    {
        _dbProvider = dbProvider;
        _personaGenerator = personaGenerator;
        _matchService = matchService;
        _recommendationService = recommendationService;
    }

    /// <summary>
    /// Gets the taste identity payload for a user.
    /// </summary>
    /// <param name="userId">User id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Taste profile response.</returns>
    [HttpGet("Users/{userId:guid}")]
    public async Task<ActionResult<TasteProfileResponse>> GetUserTaste(
        Guid userId,
        CancellationToken cancellationToken)
    {
        if (!CanAccessUser(userId))
        {
            return Forbid();
        }

        if (!TasteOptions.Current.EnableTasteProfiles)
        {
            return Ok(ColdStartResponse());
        }

        var options = TasteOptions.Current;
        var context = await _dbProvider.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
        await using (context.ConfigureAwait(false))
        {
            var row = await context.UserTasteProfiles.AsNoTracking()
                .FirstOrDefaultAsync(p => p.UserId == userId, cancellationToken)
                .ConfigureAwait(false);

            if (row is null || row.SampleCount < options.MinSamples)
            {
                var cold = ColdStartResponse();
                cold.SampleCount = row?.SampleCount ?? 0;
                cold.UpdatedAt = row?.UpdatedAt;
                return Ok(cold);
            }

            var payload = UserTasteProfileBuilder.DeserializeFeatures(row.FeaturesJson);
            var genres = TopWeights(payload.Genres, 8);
            var tags = TopWeights(payload.Tags, 8);
            var studios = TopWeights(payload.Studios, 6);
            var people = await ResolvePeopleAsync(context, payload, cancellationToken).ConfigureAwait(false);
            var affinityHints = BuildAffinityHints(payload, tags, studios, people);
            var persona = _personaGenerator.Generate(
                userId,
                payload,
                row.SampleCount,
                row.UpdatedAt,
                options.MinSamples,
                affinityHints);
            var eval = await context.TasteModelEvalRuns.AsNoTracking()
                .OrderByDescending(e => e.CreatedAt)
                .Select(e => new { e.Auc, e.CreatedAt })
                .FirstOrDefaultAsync(cancellationToken)
                .ConfigureAwait(false);

            return Ok(new TasteProfileResponse
            {
                HasProfile = true,
                SampleCount = row.SampleCount,
                UpdatedAt = row.UpdatedAt,
                Persona = new TastePersonaDto
                {
                    Code = persona.Code,
                    Title = persona.Title,
                    Blurb = persona.Blurb,
                    Focus = persona.Focus,
                    Domain = persona.Domain,
                    Stance = persona.Stance,
                    Bar = persona.Bar
                },
                Genres = genres,
                Tags = tags,
                Studios = studios,
                People = people,
                RatingMean = payload.RatingMean,
                RatingP25 = payload.RatingP25,
                RatingP75 = payload.RatingP75,
                ShadowEval = eval is null
                    ? null
                    : new TasteEvalFootnoteDto { Auc = eval.Auc, CreatedAt = eval.CreatedAt }
            });
        }
    }

    /// <summary>
    /// Matches item ids to sparse taste tiers for card badges.
    /// </summary>
    /// <param name="request">Match request.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Match response.</returns>
    [HttpPost("Match")]
    public async Task<ActionResult<TasteMatchResponse>> Match(
        [FromBody] TasteMatchRequest request,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (!CanAccessUser(request.UserId))
        {
            return Forbid();
        }

        if (!TasteOptions.Current.EnableTasteProfiles || request.ItemIds is null || request.ItemIds.Count == 0)
        {
            return Ok(new TasteMatchResponse { Matches = [] });
        }

        var matches = await _matchService.MatchAsync(request.UserId, request.ItemIds, cancellationToken)
            .ConfigureAwait(false);
        return Ok(new TasteMatchResponse
        {
            Matches = matches.Select(m => new TasteMatchItemDto
            {
                ItemId = m.ItemId,
                Tier = m.Tier,
                Score = m.Score
            }).ToList()
        });
    }

    /// <summary>
    /// Gets taste-ranked unplayed recommendations for the home feed.
    /// </summary>
    /// <param name="userId">User id.</param>
    /// <param name="includeItemTypes">Movie or Series.</param>
    /// <param name="limit">Max items to return.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Ranked recommendation items.</returns>
    [HttpGet("Recommendations")]
    public async Task<ActionResult<TasteRecommendationsResponse>> GetRecommendations(
        [FromQuery] Guid userId,
        [FromQuery] string? includeItemTypes,
        [FromQuery] int limit = TasteRecommendationService.DefaultLimit,
        CancellationToken cancellationToken = default)
    {
        if (userId == Guid.Empty || !CanAccessUser(userId))
        {
            return Forbid();
        }

        if (!TasteOptions.Current.EnableTasteProfiles
            || string.IsNullOrWhiteSpace(includeItemTypes)
            || !Enum.TryParse<BaseItemKind>(includeItemTypes, ignoreCase: true, out var itemType)
            || itemType is not (BaseItemKind.Movie or BaseItemKind.Series))
        {
            return Ok(new TasteRecommendationsResponse { Items = [] });
        }

        var items = await _recommendationService
            .GetRecommendationsAsync(userId, itemType, limit, cancellationToken)
            .ConfigureAwait(false);

        return Ok(new TasteRecommendationsResponse
        {
            Items = items.Select(m => new TasteMatchItemDto
            {
                ItemId = m.ItemId,
                Tier = m.Tier,
                Score = m.Score
            }).ToList()
        });
    }

    private bool CanAccessUser(Guid userId)
    {
        var claim = User.FindFirst(c => c.Type.Equals(UserIdClaim, StringComparison.OrdinalIgnoreCase))?.Value;
        if (string.IsNullOrWhiteSpace(claim) || !Guid.TryParse(claim, out var authenticatedId))
        {
            return User.IsInRole(AdministratorRole);
        }

        return authenticatedId.Equals(userId) || User.IsInRole(AdministratorRole);
    }

    private static TasteProfileResponse ColdStartResponse()
    {
        var persona = new TastePersonaGenerator().Generate(
            Guid.Empty,
            null,
            0,
            DateTime.UtcNow,
            minSamples: 1);
        return new TasteProfileResponse
        {
            HasProfile = false,
            Persona = new TastePersonaDto
            {
                Code = persona.Code,
                Title = persona.Title,
                Blurb = persona.Blurb,
                Focus = persona.Focus
            }
        };
    }

    private static List<TasteWeightDto> TopWeights(Dictionary<string, float> weights, int take)
        => weights
            .OrderByDescending(kvp => kvp.Value)
            .Take(take)
            .Select(kvp => new TasteWeightDto
            {
                Label = CultureInfo.InvariantCulture.TextInfo.ToTitleCase(kvp.Key),
                Weight = kvp.Value
            })
            .ToList();

    private static TasteAffinityHints BuildAffinityHints(
        UserTasteFeaturePayload payload,
        List<TasteWeightDto> tags,
        List<TasteWeightDto> studios,
        List<TastePersonDto> people)
    {
        const float gate = 0.12f;
        string? topTag = null;
        if (tags.Count > 0 && tags[0].Weight >= gate)
        {
            topTag = tags[0].Label;
        }
        else
        {
            var rawTag = payload.Tags.OrderByDescending(t => t.Value).FirstOrDefault();
            if (rawTag.Value >= gate)
            {
                topTag = CultureInfo.InvariantCulture.TextInfo.ToTitleCase(rawTag.Key);
            }
        }

        string? topStudio = null;
        if (studios.Count > 0 && studios[0].Weight >= gate)
        {
            topStudio = studios[0].Label;
        }
        else
        {
            var rawStudio = payload.Studios.OrderByDescending(t => t.Value).FirstOrDefault();
            if (rawStudio.Value >= gate)
            {
                topStudio = CultureInfo.InvariantCulture.TextInfo.ToTitleCase(rawStudio.Key);
            }
        }

        string? personName = null;
        string? personRole = null;
        if (people.Count > 0)
        {
            personName = people[0].Name;
            personRole = people[0].Role;
        }

        return new TasteAffinityHints(topTag, topStudio, personName, personRole);
    }

    private static async Task<List<TastePersonDto>> ResolvePeopleAsync(
        JellyfinDbContext context,
        UserTasteFeaturePayload payload,
        CancellationToken cancellationToken)
    {
        var directors = payload.Directors
            .OrderByDescending(kvp => kvp.Value)
            .Take(5)
            .Select(kvp => (Id: ParseGuid(kvp.Key), Weight: kvp.Value, Role: "director"))
            .Where(x => x.Id != Guid.Empty)
            .ToList();
        var actors = payload.Actors
            .OrderByDescending(kvp => kvp.Value)
            .Take(5)
            .Select(kvp => (Id: ParseGuid(kvp.Key), Weight: kvp.Value, Role: "actor"))
            .Where(x => x.Id != Guid.Empty)
            .ToList();
        var combined = directors.Concat(actors)
            .OrderByDescending(x => x.Weight)
            .Take(8)
            .ToList();
        if (combined.Count == 0)
        {
            return [];
        }

        var ids = combined.Select(c => c.Id).ToList();
        var names = await context.Peoples.AsNoTracking()
            .Where(p => ids.Contains(p.Id))
            .Select(p => new { p.Id, p.Name })
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        var nameMap = names.ToDictionary(n => n.Id, n => n.Name);
        return combined
            .Where(c => nameMap.ContainsKey(c.Id))
            .Select(c => new TastePersonDto
            {
                Id = c.Id,
                Name = nameMap[c.Id],
                Role = c.Role,
                Weight = c.Weight
            })
            .ToList();
    }

    private static Guid ParseGuid(string value)
        => Guid.TryParse(value, out var id) ? id : Guid.Empty;
}
