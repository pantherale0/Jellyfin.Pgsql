using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Persistence;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.ML;

namespace Jellyfin.Plugin.Pgsql.Taste;

/// <summary>
/// Trains a shadow Microsoft.ML ranker, evaluates on holdout data, and never serves live rankings.
/// </summary>
public sealed class TasteShadowNeuralTrainer
{
    private const float HoldoutFraction = 0.2f;
    private const int MinTotalPairs = 20;

    private readonly ILogger<TasteShadowNeuralTrainer> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="TasteShadowNeuralTrainer"/> class.
    /// </summary>
    /// <param name="logger">Logger.</param>
    public TasteShadowNeuralTrainer(ILogger<TasteShadowNeuralTrainer> logger)
    {
        _logger = logger;
    }

    /// <summary>
    /// Trains on taste profiles + movie history and writes an eval row + model artifact.
    /// </summary>
    /// <param name="context">Database context.</param>
    /// <param name="itemTypeLookup">Item type lookup.</param>
    /// <param name="modelDirectory">Directory for model artifacts.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The persisted eval run, or null when skipped.</returns>
    public async Task<TasteModelEvalRun?> TrainAndEvaluateAsync(
        JellyfinDbContext context,
        IItemTypeLookup itemTypeLookup,
        string modelDirectory,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(itemTypeLookup);
        ArgumentException.ThrowIfNullOrWhiteSpace(modelDirectory);

        var sw = Stopwatch.StartNew();
        var movieType = itemTypeLookup.BaseItemKindNames[BaseItemKind.Movie];
        var seriesType = itemTypeLookup.BaseItemKindNames[BaseItemKind.Series];
        var episodeType = itemTypeLookup.BaseItemKindNames[BaseItemKind.Episode];
        var profiles = await context.UserTasteProfiles.AsNoTracking()
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        if (profiles.Count == 0)
        {
            return await PersistSkipAsync(context, sw.ElapsedMilliseconds, "No taste profiles available", cancellationToken)
                .ConfigureAwait(false);
        }

        var examples = new List<TasteExample>();
        foreach (var profile in profiles)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var payload = UserTasteProfileBuilder.DeserializeFeatures(profile.FeaturesJson);
            var positiveIds = await LoadPositiveMediaIdsAsync(
                    context,
                    profile.UserId,
                    movieType,
                    seriesType,
                    episodeType,
                    cancellationToken)
                .ConfigureAwait(false);

            if (positiveIds.Count == 0)
            {
                continue;
            }

            var positiveSet = positiveIds.ToHashSet();
            var movieNegatives = await context.BaseItems.AsNoTracking()
                .Where(i => i.Type == movieType && !positiveSet.Contains(i.Id))
                .OrderBy(i => i.Id)
                .Select(i => i.Id)
                .Take(Math.Max(positiveIds.Count, 5))
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);
            var seriesNegatives = await context.BaseItems.AsNoTracking()
                .Where(i => i.Type == seriesType && !positiveSet.Contains(i.Id))
                .OrderBy(i => i.Id)
                .Select(i => i.Id)
                .Take(Math.Max(positiveIds.Count, 5))
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);
            var negatives = movieNegatives.Concat(seriesNegatives).Distinct().ToList();

            var allIds = positiveIds.Concat(negatives).Distinct().ToList();
            var featuresByItem = await LoadCandidateFeaturesAsync(context, allIds, cancellationToken)
                .ConfigureAwait(false);

            foreach (var id in positiveIds)
            {
                if (featuresByItem.TryGetValue(id, out var features))
                {
                    examples.Add(ToExample(payload, features, label: true));
                }
            }

            foreach (var id in negatives)
            {
                if (featuresByItem.TryGetValue(id, out var features))
                {
                    examples.Add(ToExample(payload, features, label: false));
                }
            }
        }

        if (examples.Count < MinTotalPairs)
        {
            return await PersistSkipAsync(
                    context,
                    sw.ElapsedMilliseconds,
                    $"Insufficient training pairs ({examples.Count})",
                    cancellationToken)
                .ConfigureAwait(false);
        }

        var rng = new Random(42);
        var shuffled = examples.OrderBy(_ => rng.Next()).ToList();
        var holdoutCount = Math.Max(1, (int)(shuffled.Count * HoldoutFraction));
        var holdout = shuffled.Take(holdoutCount).ToList();
        var train = shuffled.Skip(holdoutCount).ToList();
        if (train.Count < 10)
        {
            return await PersistSkipAsync(context, sw.ElapsedMilliseconds, "Holdout left too few train rows", cancellationToken)
                .ConfigureAwait(false);
        }

        var mlContext = new MLContext(seed: 42);
        var trainData = mlContext.Data.LoadFromEnumerable(train);
        var pipeline = mlContext.Transforms
            .Concatenate(
                "Features",
                nameof(TasteExample.GenreOverlap),
                nameof(TasteExample.TagOverlap),
                nameof(TasteExample.StudioOverlap),
                nameof(TasteExample.DirectorOverlap),
                nameof(TasteExample.ActorOverlap),
                nameof(TasteExample.RatingDistance))
            .Append(mlContext.BinaryClassification.Trainers.SdcaLogisticRegression(
                labelColumnName: nameof(TasteExample.Label),
                featureColumnName: "Features"));

        var model = pipeline.Fit(trainData);
        Directory.CreateDirectory(modelDirectory);
        var fileName = string.Create(
            CultureInfo.InvariantCulture,
            $"taste-shadow-{DateTime.UtcNow:yyyyMMddHHmmss}.zip");
        var modelPath = Path.Combine(modelDirectory, fileName);
        mlContext.Model.Save(model, trainData.Schema, modelPath);

        var holdoutData = mlContext.Data.LoadFromEnumerable(holdout);
        var predictions = model.Transform(holdoutData);
        var metrics = mlContext.BinaryClassification.Evaluate(
            predictions,
            labelColumnName: nameof(TasteExample.Label),
            scoreColumnName: "Score");

        var scored = mlContext.Data
            .CreateEnumerable<TastePrediction>(predictions, reuseRowObject: false)
            .Select((p, i) => (Score: p.Probability, Label: holdout[i].Label))
            .OrderByDescending(x => x.Score)
            .ToList();
        var precisionAt10 = PrecisionAtK(scored, 10);

        sw.Stop();
        var run = new TasteModelEvalRun
        {
            Id = Guid.NewGuid(),
            CreatedAt = DateTime.UtcNow,
            TrainDurationMs = sw.ElapsedMilliseconds,
            PositiveCount = examples.Count(e => e.Label),
            NegativeCount = examples.Count(e => !e.Label),
            HoldoutCount = holdout.Count,
            Accuracy = metrics.Accuracy,
            Auc = metrics.AreaUnderRocCurve,
            PrecisionAt10 = precisionAt10,
            ModelPath = fileName,
            Notes = null
        };

        context.TasteModelEvalRuns.Add(run);
        await context.SaveChangesAsync(cancellationToken).ConfigureAwait(false);

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation(
                "Shadow taste model trained: AUC={Auc} Acc={Acc} P10={P10} pairs={Pairs} holdout={Holdout}",
                run.Auc,
                run.Accuracy,
                run.PrecisionAt10,
                examples.Count,
                holdout.Count);
        }

        return run;
    }

    private static async Task<List<Guid>> LoadPositiveMediaIdsAsync(
        JellyfinDbContext context,
        Guid userId,
        string movieType,
        string seriesType,
        string episodeType,
        CancellationToken cancellationToken)
    {
        var movieIds = await context.UserData.AsNoTracking()
            .Where(ud => ud.UserId == userId
                && (ud.IsFavorite || ud.Likes == true || ud.Played || ud.PlayCount > 0))
            .Join(
                context.BaseItems.AsNoTracking().Where(i => i.Type == movieType),
                ud => ud.ItemId,
                i => i.Id,
                (ud, i) => i.Id)
            .Distinct()
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        var seriesIds = await context.UserData.AsNoTracking()
            .Where(ud => ud.UserId == userId
                && (ud.IsFavorite || ud.Likes == true || ud.Played || ud.PlayCount > 0))
            .Join(
                context.BaseItems.AsNoTracking().Where(i => i.Type == seriesType),
                ud => ud.ItemId,
                i => i.Id,
                (ud, i) => i.Id)
            .Distinct()
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        var episodeSeriesIds = await context.UserData.AsNoTracking()
            .Where(ud => ud.UserId == userId && (ud.Played || ud.PlayCount > 0))
            .Join(
                context.BaseItems.AsNoTracking()
                    .Where(i => i.Type == episodeType && i.SeriesId != null),
                ud => ud.ItemId,
                i => i.Id,
                (ud, i) => i.SeriesId!.Value)
            .Distinct()
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        return movieIds.Concat(seriesIds).Concat(episodeSeriesIds).Distinct().ToList();
    }

    private static async Task<Dictionary<Guid, TasteCandidateFeatures>> LoadCandidateFeaturesAsync(
        JellyfinDbContext context,
        List<Guid> itemIds,
        CancellationToken cancellationToken)
    {
        var valueRows = await context.ItemValuesMap.AsNoTracking()
            .Where(m => itemIds.Contains(m.ItemId)
                && (m.ItemValue.Type == ItemValueType.Genre
                    || m.ItemValue.Type == ItemValueType.Tags
                    || m.ItemValue.Type == ItemValueType.Studios))
            .Select(m => new { m.ItemId, m.ItemValue.Type, m.ItemValue.CleanValue })
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        var peopleRows = await context.PeopleBaseItemMap.AsNoTracking()
            .Where(m => itemIds.Contains(m.ItemId)
                && (m.People.PersonType == nameof(PersonKind.Director)
                    || m.People.PersonType == nameof(PersonKind.Actor)
                    || m.People.PersonType == nameof(PersonKind.GuestStar)))
            .Select(m => new { m.ItemId, m.PeopleId, m.People.PersonType })
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        var ratings = await context.BaseItems.AsNoTracking()
            .Where(i => itemIds.Contains(i.Id))
            .Select(i => new { i.Id, i.CommunityRating })
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        var result = new Dictionary<Guid, TasteCandidateFeatures>();
        foreach (var id in itemIds)
        {
            var genres = valueRows
                .Where(r => r.ItemId == id && r.Type == ItemValueType.Genre)
                .Select(r => r.CleanValue)
                .Where(v => !string.IsNullOrWhiteSpace(v))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();
            var tags = valueRows
                .Where(r => r.ItemId == id && r.Type == ItemValueType.Tags)
                .Select(r => r.CleanValue)
                .Where(v => !string.IsNullOrWhiteSpace(v))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();
            var studios = valueRows
                .Where(r => r.ItemId == id && r.Type == ItemValueType.Studios)
                .Select(r => r.CleanValue)
                .Where(v => !string.IsNullOrWhiteSpace(v))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();
            var directors = peopleRows
                .Where(r => r.ItemId == id && r.PersonType == nameof(PersonKind.Director))
                .Select(r => r.PeopleId)
                .Distinct()
                .ToList();
            var actors = peopleRows
                .Where(r => r.ItemId == id && r.PersonType != nameof(PersonKind.Director))
                .Select(r => r.PeopleId)
                .Distinct()
                .ToList();
            var rating = ratings.FirstOrDefault(r => r.Id == id)?.CommunityRating;

            result[id] = new TasteCandidateFeatures(genres, tags, studios, directors, actors, rating);
        }

        return result;
    }

    private static TasteExample ToExample(
        UserTasteFeaturePayload profile,
        TasteCandidateFeatures features,
        bool label)
    {
        return new TasteExample
        {
            Label = label,
            GenreOverlap = SumWeights(profile.Genres, features.Genres),
            TagOverlap = SumWeights(profile.Tags, features.Tags),
            StudioOverlap = SumWeights(profile.Studios, features.Studios),
            DirectorOverlap = SumGuidWeights(profile.Directors, features.DirectorIds),
            ActorOverlap = SumGuidWeights(profile.Actors, features.ActorIds),
            RatingDistance = RatingDistance(profile, features.CommunityRating)
        };
    }

    private static float SumWeights(Dictionary<string, float> weights, IReadOnlyCollection<string> values)
    {
        float sum = 0f;
        foreach (var value in values)
        {
            if (weights.TryGetValue(value, out var w))
            {
                sum += w;
            }
        }

        return sum;
    }

    private static float SumGuidWeights(Dictionary<string, float> weights, IReadOnlyCollection<Guid> ids)
    {
        float sum = 0f;
        foreach (var id in ids)
        {
            if (weights.TryGetValue(id.ToString("N"), out var w)
                || weights.TryGetValue(id.ToString("D"), out w))
            {
                sum += w;
            }
        }

        return sum;
    }

    private static float RatingDistance(UserTasteFeaturePayload profile, float? rating)
    {
        if (rating is null || profile.RatingMean is null)
        {
            return 0f;
        }

        return Math.Abs(rating.Value - profile.RatingMean.Value);
    }

    private static double PrecisionAtK(List<(float Score, bool Label)> ranked, int k)
    {
        if (ranked.Count == 0)
        {
            return 0;
        }

        var top = ranked.Take(Math.Min(k, ranked.Count)).ToList();
        return top.Count(x => x.Label) / (double)top.Count;
    }

    private static async Task<TasteModelEvalRun> PersistSkipAsync(
        JellyfinDbContext context,
        long elapsedMs,
        string notes,
        CancellationToken cancellationToken)
    {
        var run = new TasteModelEvalRun
        {
            Id = Guid.NewGuid(),
            CreatedAt = DateTime.UtcNow,
            TrainDurationMs = elapsedMs,
            PositiveCount = 0,
            NegativeCount = 0,
            HoldoutCount = 0,
            Notes = notes
        };
        context.TasteModelEvalRuns.Add(run);
        await context.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return run;
    }

    private sealed class TasteExample
    {
        public bool Label { get; set; }

        public float GenreOverlap { get; set; }

        public float TagOverlap { get; set; }

        public float StudioOverlap { get; set; }

        public float DirectorOverlap { get; set; }

        public float ActorOverlap { get; set; }

        public float RatingDistance { get; set; }
    }

    private sealed class TastePrediction
    {
        public bool Label { get; set; }

        public float Probability { get; set; }
    }
}
