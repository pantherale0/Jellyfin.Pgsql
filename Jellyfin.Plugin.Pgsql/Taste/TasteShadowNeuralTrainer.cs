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
        var now = DateTime.UtcNow;
        var lookbackDays = TasteOptions.Current.LookbackDays;
        var cutoff = now.AddDays(-lookbackDays);

        foreach (var profile in profiles)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var payload = UserTasteProfileBuilder.DeserializeFeatures(profile.FeaturesJson);
            var labeled = await LoadLabeledMediaAsync(
                    context,
                    profile.UserId,
                    movieType,
                    seriesType,
                    episodeType,
                    cutoff,
                    now,
                    cancellationToken)
                .ConfigureAwait(false);

            if (labeled.Count == 0)
            {
                continue;
            }

            var labeledSet = labeled.Select(l => l.ItemId).ToHashSet();
            var positiveCount = labeled.Count(l => l.IsPositive);
            var negativeNeeded = Math.Max(positiveCount, 5);
            var movieNegatives = await context.BaseItems.AsNoTracking()
                .Where(i => i.Type == movieType && !labeledSet.Contains(i.Id))
                .OrderBy(i => i.Id)
                .Select(i => i.Id)
                .Take(negativeNeeded)
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);
            var seriesNegatives = await context.BaseItems.AsNoTracking()
                .Where(i => i.Type == seriesType && !labeledSet.Contains(i.Id))
                .OrderBy(i => i.Id)
                .Select(i => i.Id)
                .Take(negativeNeeded)
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);
            var catalogNegatives = movieNegatives.Concat(seriesNegatives).Distinct().ToList();

            var allIds = labeled.Select(l => l.ItemId).Concat(catalogNegatives).Distinct().ToList();
            var featuresByItem = await LoadCandidateFeaturesAsync(context, allIds, cancellationToken)
                .ConfigureAwait(false);

            foreach (var row in labeled.Where(l => featuresByItem.ContainsKey(l.ItemId)))
            {
                examples.Add(ToExample(payload, featuresByItem[row.ItemId], row.IsPositive, row.Weight));
            }

            foreach (var id in catalogNegatives.Where(featuresByItem.ContainsKey))
            {
                examples.Add(ToExample(
                    payload,
                    featuresByItem[id],
                    label: false,
                    weight: TasteEngagementWeights.NeuralCatalogNegativeWeight));
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
                featureColumnName: "Features",
                exampleWeightColumnName: nameof(TasteExample.Weight)));

        var model = pipeline.Fit(trainData);
        Directory.CreateDirectory(modelDirectory);
        var fileName = string.Create(
            CultureInfo.InvariantCulture,
            $"taste-shadow-{DateTime.UtcNow:yyyyMMddHHmmss}.zip");
        var modelPath = Path.Join(modelDirectory, fileName);
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
            Notes = "Weighted training (completion + For You impressions)"
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

    private static async Task<List<LabeledMedia>> LoadLabeledMediaAsync(
        JellyfinDbContext context,
        Guid userId,
        string movieType,
        string seriesType,
        string episodeType,
        DateTime cutoff,
        DateTime nowUtc,
        CancellationToken cancellationToken)
    {
        var recommended = (await context.UserTasteRecommendationImpressions.AsNoTracking()
                .Where(i => i.UserId == userId && i.ServedAt >= cutoff)
                .Select(i => i.ItemId)
                .Distinct()
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false))
            .ToHashSet();

        var labeled = new List<LabeledMedia>();
        await AppendLabeledForTypeAsync(
                context,
                userId,
                movieType,
                cutoff,
                nowUtc,
                recommended,
                labeled,
                cancellationToken)
            .ConfigureAwait(false);
        await AppendLabeledForTypeAsync(
                context,
                userId,
                seriesType,
                cutoff,
                nowUtc,
                recommended,
                labeled,
                cancellationToken)
            .ConfigureAwait(false);

        // Episode plays roll up to series positives when deep/mid; abandons excluded from positives.
        var episodeSeriesPositives = await context.UserData.AsNoTracking()
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

        var existing = labeled.Select(l => l.ItemId).ToHashSet();
        foreach (var seriesId in episodeSeriesPositives.Where(id => !existing.Contains(id)))
        {
            var weight = recommended.Contains(seriesId)
                ? TasteEngagementWeights.NeuralRecPositiveWeight
                : TasteEngagementWeights.NeuralDeepPlayWeight;
            labeled.Add(new LabeledMedia(seriesId, true, weight));
        }

        return labeled;
    }

    private static async Task AppendLabeledForTypeAsync(
        JellyfinDbContext context,
        Guid userId,
        string itemType,
        DateTime cutoff,
        DateTime nowUtc,
        HashSet<Guid> recommended,
        List<LabeledMedia> labeled,
        CancellationToken cancellationToken)
    {
        // UserData PK includes CustomDataKey — alternate versions yield multiple rows per ItemId.
        var userDataRaw = await context.UserData.AsNoTracking()
            .Where(ud => ud.UserId == userId
                && (ud.IsFavorite
                    || ud.Likes == true
                    || ud.Likes == false
                    || ud.Played
                    || ud.PlayCount > 0
                    || ud.PlaybackPositionTicks > 0
                    || (ud.LastPlayedDate != null && ud.LastPlayedDate >= cutoff)))
            .Join(
                context.BaseItems.AsNoTracking().Where(i => i.Type == itemType),
                ud => ud.ItemId,
                i => i.Id,
                (ud, i) => new
                {
                    ud.ItemId,
                    ud.IsFavorite,
                    ud.Likes,
                    ud.Played,
                    ud.PlayCount,
                    ud.Rating,
                    ud.PlaybackPositionTicks,
                    ud.LastPlayedDate,
                    i.RunTimeTicks
                })
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        var userDataRows = userDataRaw.Select(r => new UserDataEngagementRow(
            r.ItemId,
            r.IsFavorite,
            r.Likes,
            r.Played,
            r.PlayCount,
            r.Rating,
            r.PlaybackPositionTicks,
            r.LastPlayedDate,
            r.RunTimeTicks));

        var playbackAgg = await context.PlaybackActivity.AsNoTracking()
            .Where(p => p.UserId == userId && p.DatePlayed >= cutoff && p.PlayedTicks > 0)
            .Join(
                context.BaseItems.AsNoTracking().Where(i => i.Type == itemType),
                p => p.ItemId,
                i => i.Id,
                (p, i) => new { p.ItemId, p.PlayedTicks, p.DatePlayed, i.RunTimeTicks })
            .GroupBy(p => p.ItemId)
            .Select(g => new
            {
                ItemId = g.Key,
                MaxPlayedTicks = g.Max(x => x.PlayedTicks),
                LastPlayed = g.Max(x => x.DatePlayed),
                RunTimeTicks = g.Max(x => x.RunTimeTicks)
            })
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        var playbackByItem = playbackAgg.ToDictionary(p => p.ItemId);
        var userDataByItem = UserDataEngagementAggregation.ToDictionaryByItemId(userDataRows);
        var itemIds = userDataByItem.Keys.Union(playbackByItem.Keys).ToList();

        foreach (var itemId in itemIds)
        {
            var hasUd = userDataByItem.TryGetValue(itemId, out var ud);
            playbackByItem.TryGetValue(itemId, out var pb);
            var maxTicks = Math.Max(hasUd ? ud.PlaybackPositionTicks : 0L, pb?.MaxPlayedTicks ?? 0L);
            var runTime = hasUd ? ud.RunTimeTicks : null;
            runTime ??= pb?.RunTimeTicks;
            DateTime? lastPlayed = null;
            if (hasUd && ud.LastPlayedDate is DateTime udPlayed)
            {
                lastPlayed = udPlayed.ToUniversalTime();
            }

            if (pb?.LastPlayed is DateTime pbPlayed)
            {
                var pbUtc = pbPlayed.ToUniversalTime();
                if (lastPlayed is null || pbUtc > lastPlayed)
                {
                    lastPlayed = pbUtc;
                }
            }

            var input = new TasteEngagementInput(
                IsFavorite: hasUd && ud.IsFavorite,
                Likes: hasUd ? ud.Likes : null,
                Played: hasUd && ud.Played,
                PlayCount: hasUd ? ud.PlayCount : 0,
                UserRating: hasUd ? ud.Rating : null,
                MaxPlayedTicks: maxTicks,
                RunTimeTicks: runTime,
                LastPlayedUtc: lastPlayed,
                HasLaterPlayWithinNoReturnWindow: false,
                WasRecommended: recommended.Contains(itemId));

            if (!TasteEngagementWeights.TryGetNeuralExample(input, nowUtc, out var isPositive, out var weight))
            {
                continue;
            }

            labeled.Add(new LabeledMedia(itemId, isPositive, weight));
        }
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
        bool label,
        float weight)
    {
        return new TasteExample
        {
            Label = label,
            Weight = weight,
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
        foreach (var value in values.Where(weights.ContainsKey))
        {
            sum += weights[value];
        }

        return sum;
    }

    private static float SumGuidWeights(Dictionary<string, float> weights, IReadOnlyCollection<Guid> ids)
    {
        float sum = 0f;
        foreach (var weight in ids
                     .Select(id =>
                         weights.TryGetValue(id.ToString("N"), out var w)
                         || weights.TryGetValue(id.ToString("D"), out w)
                             ? (float?)w
                             : null)
                     .Where(w => w.HasValue)
                     .Select(w => w!.Value))
        {
            sum += weight;
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

        public float Weight { get; set; } = 1f;

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

    private sealed class LabeledMedia
    {
        public LabeledMedia(Guid itemId, bool isPositive, float weight)
        {
            ItemId = itemId;
            IsPositive = isPositive;
            Weight = weight;
        }

        public Guid ItemId { get; }

        public bool IsPositive { get; }

        public float Weight { get; }
    }
}
