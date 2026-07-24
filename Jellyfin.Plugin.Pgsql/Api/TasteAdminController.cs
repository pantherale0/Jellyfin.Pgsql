using System;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.Pgsql.Taste;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Jellyfin.Plugin.Pgsql.Api;

/// <summary>
/// Administrator APIs for shadow taste-model evaluation metrics.
/// </summary>
[ApiController]
[Authorize(Roles = AdministratorRole)]
[Route("Pgsql/Admin")]
public sealed class TasteAdminController : ControllerBase
{
    private const string AdministratorRole = "Administrator";
    private const int DefaultLimit = 50;
    private const int MaxLimit = 200;

    private readonly IDbContextFactory<JellyfinDbContext> _dbProvider;

    /// <summary>
    /// Initializes a new instance of the <see cref="TasteAdminController"/> class.
    /// </summary>
    /// <param name="dbProvider">Database context factory.</param>
    public TasteAdminController(IDbContextFactory<JellyfinDbContext> dbProvider)
    {
        _dbProvider = dbProvider;
    }

    /// <summary>
    /// Returns shadow-training status and recent evaluation runs.
    /// </summary>
    /// <param name="limit">Maximum number of runs to return (default 50, max 200).</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Status, latest run, and history.</returns>
    [HttpGet("Taste/ShadowEval")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<ActionResult<TasteShadowEvalResponse>> GetShadowEval(
        [FromQuery] int limit = DefaultLimit,
        CancellationToken cancellationToken = default)
    {
        var take = Math.Clamp(limit, 1, MaxLimit);
        var options = TasteOptions.Current;

        await using var context = await _dbProvider.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
        var rows = await context.TasteModelEvalRuns.AsNoTracking()
            .OrderByDescending(e => e.CreatedAt)
            .Take(take)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        var runs = rows.Select(ToDto).ToList();
        return Ok(new TasteShadowEvalResponse
        {
            Status = new TasteShadowEvalStatusDto
            {
                TasteEnabled = options.EnableTasteProfiles,
                ShadowTrainingEnabled = options.EnableNeuralShadowTraining,
                NeuralServingEnabled = options.UseNeuralForServing
            },
            Latest = runs.Count > 0 ? runs[0] : null,
            Runs = runs
        });
    }

    private static TasteModelEvalRunDto ToDto(TasteModelEvalRun row)
    {
        // Successful runs may still carry informational Notes (e.g. training mode).
        // Skipped runs have Notes explaining why and no eval metrics.
        var hasMetrics = row.Auc is not null || row.Accuracy is not null || row.PrecisionAt10 is not null;

        return new TasteModelEvalRunDto
        {
            Id = row.Id,
            CreatedAt = row.CreatedAt,
            TrainDurationMs = row.TrainDurationMs,
            PositiveCount = row.PositiveCount,
            NegativeCount = row.NegativeCount,
            HoldoutCount = row.HoldoutCount,
            Accuracy = row.Accuracy,
            Auc = row.Auc,
            PrecisionAt10 = row.PrecisionAt10,
            ModelPath = string.IsNullOrWhiteSpace(row.ModelPath) ? null : Path.GetFileName(row.ModelPath),
            Notes = row.Notes,
            Succeeded = hasMetrics
        };
    }
}
