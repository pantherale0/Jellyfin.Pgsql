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
/// Trains a shadow Microsoft.ML ranker and evaluates on a time-based holdout.
/// Live serving is gated by <see cref="TasteOptions.UseNeuralForServing"/>.
/// </summary>
public sealed class TasteShadowNeuralTrainer
{
    private const int MinTotalPairs = 20;
    private const float HardGenreNegativeFraction = 0.7f;
    private const int TopGenreCount = 5;

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
        itemTypeLookup.BaseItemKindNames.TryGetValue(BaseItemKind.BoxSet, out var boxSetType);
        var profiles = await context.UserTasteProfiles.AsNoTracking()
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        if (profiles.Count == 0)
        {
            return await PersistSkipAsync(context, sw.ElapsedMilliseconds, "No taste profiles available", cancellationToken)
                .ConfigureAwait(false);
        }

        var examples = new List<TimedExample>();
        var now = DateTime.UtcNow;
        var lookbackDays = TasteOptions.Current.LookbackDays;
        var cutoff = now.AddDays(-lookbackDays);
        var rng = new Random(42);

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

            var skipNegatives = await LoadImpressionSkipNegativesAsync(
                    context,
                    profile.UserId,
                    cutoff,
                    now,
                    labeled.Select(l => l.ItemId).ToHashSet(),
                    cancellationToken)
                .ConfigureAwait(false);
            labeled.AddRange(skipNegatives);

            if (labeled.Count == 0)
            {
                continue;
            }

            var labeledSet = labeled.Select(l => l.ItemId).ToHashSet();
            var positiveCount = labeled.Count(l => l.IsPositive);
            var negativeNeeded = Math.Max(positiveCount, 5);
            var movieNegatives = await SampleCatalogNegativesAsync(
                    context,
                    movieType,
                    payload,
                    labeledSet,
                    negativeNeeded,
                    rng,
                    cancellationToken)
                .ConfigureAwait(false);
            var seriesNegatives = await SampleCatalogNegativesAsync(
                    context,
                    seriesType,
                    payload,
                    labeledSet,
                    negativeNeeded,
                    rng,
                    cancellationToken)
                .ConfigureAwait(false);
            var catalogNegatives = movieNegatives.Concat(seriesNegatives).Distinct().ToList();

            var allIds = labeled.Select(l => l.ItemId).Concat(catalogNegatives).Distinct().ToList();
            var featuresByItem = await TasteCandidateFeatureLoader
                .LoadAsync(context, allIds, cancellationToken, seriesType, boxSetType)
                .ConfigureAwait(false);

            foreach (var row in labeled.Where(l => featuresByItem.ContainsKey(l.ItemId)))
            {
                examples.Add(new TimedExample(
                    TasteNeuralExampleBuilder.Create(payload, featuresByItem[row.ItemId], row.IsPositive, row.Weight),
                    profile.UserId,
                    row.EventUtc,
                    isCatalogNegative: false));
            }

            foreach (var id in catalogNegatives.Where(featuresByItem.ContainsKey))
            {
                examples.Add(new TimedExample(
                    TasteNeuralExampleBuilder.Create(
                        payload,
                        featuresByItem[id],
                        label: false,
                        weight: TasteEngagementWeights.NeuralCatalogNegativeWeight),
                    profile.UserId,
                    cutoff,
                    isCatalogNegative: true));
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

        var labeledForSplit = examples.Where(e => !e.IsCatalogNegative).ToList();
        var minEvent = labeledForSplit.Count > 0
            ? labeledForSplit.Min(e => e.EventUtc)
            : examples.Min(e => e.EventUtc);
        var splitPreview = TasteEvalMetrics.SplitByEventTime(
            labeledForSplit.Count > 0 ? labeledForSplit : examples,
            e => e.EventUtc,
            TasteEvalMetrics.DefaultHoldoutFraction);
        var catalogMid = TasteEvalMetrics.TrainWindowMidpoint(minEvent, splitPreview.WindowStart);
        foreach (var row in examples.Where(e => e.IsCatalogNegative))
        {
            row.EventUtc = catalogMid;
        }

        var split = TasteEvalMetrics.SplitByEventTime(
            examples,
            e => e.EventUtc,
            TasteEvalMetrics.DefaultHoldoutFraction);
        var trainRows = split.Train;
        var holdoutRows = split.Holdout;
        if (trainRows.Count < 10)
        {
            return await PersistSkipAsync(context, sw.ElapsedMilliseconds, "Holdout left too few train rows", cancellationToken)
                .ConfigureAwait(false);
        }

        var train = trainRows.Select(r => r.Example).ToList();
        var holdout = holdoutRows.Select(r => r.Example).ToList();

        var mlContext = new MLContext(seed: 42);
        var trainData = mlContext.Data.LoadFromEnumerable(train);
        var pipeline = mlContext.Transforms
            .Concatenate("Features", TasteNeuralExample.FeatureColumnNames)
            .Append(mlContext.BinaryClassification.Trainers.SdcaLogisticRegression(
                labelColumnName: nameof(TasteNeuralExample.Label),
                featureColumnName: "Features",
                exampleWeightColumnName: nameof(TasteNeuralExample.Weight)));

        var model = pipeline.Fit(trainData);
        Directory.CreateDirectory(modelDirectory);
        var fileName = string.Create(
            CultureInfo.InvariantCulture,
            $"taste-shadow-{DateTime.UtcNow:yyyyMMddHHmmss}.zip");
        var modelPath = Path.Join(modelDirectory, fileName);
        mlContext.Model.Save(model, trainData.Schema, modelPath);

        double? auc = null;
        double? accuracy = null;
        double precisionAt10 = 0;
        double meanPrecisionAt10 = 0;
        var notes = "Weighted training (completion + For You impressions + hard negatives)";
        if (holdout.Count > 0)
        {
            var holdoutData = mlContext.Data.LoadFromEnumerable(holdout);
            var predictions = model.Transform(holdoutData);
            if (TasteEvalMetrics.HasBothBinaryClasses(holdout.Select(e => e.Label)))
            {
                var metrics = mlContext.BinaryClassification.Evaluate(
                    predictions,
                    labelColumnName: nameof(TasteNeuralExample.Label),
                    scoreColumnName: "Score");
                auc = metrics.AreaUnderRocCurve;
                accuracy = metrics.Accuracy;
            }
            else
            {
                notes += "; AUC skipped (holdout has a single class)";
            }

            var scored = mlContext.Data
                .CreateEnumerable<TasteNeuralPrediction>(predictions, reuseRowObject: false)
                .Select((p, i) => (Score: p.Probability, Label: holdout[i].Label, UserId: holdoutRows[i].UserId))
                .ToList();
            var rankedGlobal = scored
                .OrderByDescending(x => x.Score)
                .Select(x => (x.Score, x.Label))
                .ToList();
            precisionAt10 = TasteEvalMetrics.PrecisionAtK(rankedGlobal, 10);
            meanPrecisionAt10 = TasteEvalMetrics.MeanPrecisionAtK(
                scored.Select(x => (x.UserId, x.Score, x.Label)),
                10);
        }

        var engage = await TasteForYouEngageMetrics.ComputeAsync(
                context,
                DateTime.UtcNow,
                lookbackDays,
                TasteEngagementWeights.ImpressionSkipConfirmDays,
                cancellationToken)
            .ConfigureAwait(false);

        sw.Stop();
        var run = new TasteModelEvalRun
        {
            Id = Guid.NewGuid(),
            CreatedAt = DateTime.UtcNow,
            TrainDurationMs = sw.ElapsedMilliseconds,
            PositiveCount = examples.Count(e => e.Example.Label),
            NegativeCount = examples.Count(e => !e.Example.Label),
            HoldoutCount = holdout.Count,
            Accuracy = accuracy,
            Auc = auc,
            PrecisionAt10 = precisionAt10,
            ModelPath = fileName,
            Notes = notes,
            SplitType = TasteEvalMetrics.SplitTypeTimeBased,
            HoldoutFraction = TasteEvalMetrics.DefaultHoldoutFraction,
            HoldoutWindowStart = split.WindowStart,
            HoldoutWindowEnd = split.WindowEnd,
            TrainCount = train.Count,
            MeanPrecisionAt10 = meanPrecisionAt10,
            ForYouEngageRate = engage.Rate,
            ForYouEngageWindowDays = engage.WindowDays,
            ForYouImpressionCount = engage.ImpressionCount,
            ForYouEngageCount = engage.EngageCount
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

    private static async Task<List<Guid>> SampleCatalogNegativesAsync(
        JellyfinDbContext context,
        string itemType,
        UserTasteFeaturePayload payload,
        HashSet<Guid> labeledSet,
        int negativeNeeded,
        Random rng,
        CancellationToken cancellationToken)
    {
        if (negativeNeeded <= 0)
        {
            return [];
        }

        var hardCount = (int)Math.Round(negativeNeeded * HardGenreNegativeFraction);
        var randomCount = Math.Max(0, negativeNeeded - hardCount);
        var selected = new List<Guid>(negativeNeeded);

        var topGenres = payload.Genres
            .OrderByDescending(kvp => kvp.Value)
            .ThenBy(kvp => kvp.Key, StringComparer.OrdinalIgnoreCase)
            .Take(TopGenreCount)
            .Select(kvp => kvp.Key)
            .Where(g => !string.IsNullOrWhiteSpace(g))
            .ToList();

        if (topGenres.Count > 0 && hardCount > 0)
        {
            var hardPool = await context.ItemValuesMap.AsNoTracking()
                .Where(m => m.ItemValue.Type == ItemValueType.Genre
                    && topGenres.Contains(m.ItemValue.CleanValue)
                    && m.Item.Type == itemType
                    && !m.Item.IsVirtualItem
                    && !labeledSet.Contains(m.ItemId))
                .Select(m => m.ItemId)
                .Distinct()
                .Take(Math.Max(hardCount * 8, 40))
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);

            selected.AddRange(ShuffleTake(hardPool, hardCount, rng));
        }

        var selectedSet = selected.ToHashSet();
        selectedSet.UnionWith(labeledSet);
        var randomPool = await context.BaseItems.AsNoTracking()
            .Where(i => i.Type == itemType && !i.IsVirtualItem && !selectedSet.Contains(i.Id))
            .Select(i => i.Id)
            .Take(Math.Max(randomCount * 8, 40))
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        selected.AddRange(ShuffleTake(randomPool, randomCount, rng));

        // Backfill if hard/random pools were short.
        if (selected.Count < negativeNeeded)
        {
            var fillSet = selected.ToHashSet();
            fillSet.UnionWith(labeledSet);
            var fillPool = await context.BaseItems.AsNoTracking()
                .Where(i => i.Type == itemType && !i.IsVirtualItem && !fillSet.Contains(i.Id))
                .Select(i => i.Id)
                .Take(negativeNeeded - selected.Count)
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);
            selected.AddRange(fillPool);
        }

        return selected.Distinct().Take(negativeNeeded).ToList();
    }

    private static List<Guid> ShuffleTake(List<Guid> pool, int count, Random rng)
    {
        if (pool.Count == 0 || count <= 0)
        {
            return [];
        }

        for (var i = pool.Count - 1; i > 0; i--)
        {
            var j = rng.Next(i + 1);
            (pool[i], pool[j]) = (pool[j], pool[i]);
        }

        return pool.Take(Math.Min(count, pool.Count)).ToList();
    }

    private static async Task<List<LabeledMedia>> LoadImpressionSkipNegativesAsync(
        JellyfinDbContext context,
        Guid userId,
        DateTime cutoff,
        DateTime nowUtc,
        HashSet<Guid> alreadyLabeled,
        CancellationToken cancellationToken)
    {
        var confirmBefore = nowUtc.AddDays(-TasteEngagementWeights.ImpressionSkipConfirmDays);
        var impressions = await context.UserTasteRecommendationImpressions.AsNoTracking()
            .Where(i => i.UserId == userId
                && i.ServedAt >= cutoff
                && i.ServedAt <= confirmBefore
                && !alreadyLabeled.Contains(i.ItemId))
            .Select(i => new { i.ItemId, i.ServedAt })
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        if (impressions.Count == 0)
        {
            return [];
        }

        var itemIds = impressions.Select(i => i.ItemId).Distinct().ToList();
        var engaged = await context.UserData.AsNoTracking()
            .Where(ud => ud.UserId == userId
                && itemIds.Contains(ud.ItemId)
                && (ud.IsFavorite
                    || ud.Likes == true
                    || ud.Played
                    || ud.PlayCount > 0
                    || ud.PlaybackPositionTicks > 0))
            .Select(ud => ud.ItemId)
            .Distinct()
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        var engagedSet = engaged.ToHashSet();

        return impressions
            .Where(i => !engagedSet.Contains(i.ItemId))
            .GroupBy(i => i.ItemId)
            .Select(g =>
            {
                var servedAt = g.Min(x => x.ServedAt);
                var weight = TasteEngagementWeights.ApplyNeuralRecencyDecay(
                    TasteEngagementWeights.NeuralImpressionSkipWeight,
                    servedAt,
                    nowUtc);
                return new LabeledMedia(g.Key, false, weight, servedAt);
            })
            .ToList();
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
            labeled.Add(new LabeledMedia(seriesId, true, weight, cutoff));
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

            labeled.Add(new LabeledMedia(itemId, isPositive, weight, lastPlayed ?? cutoff));
        }
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
            Notes = notes,
            SplitType = TasteEvalMetrics.SplitTypeTimeBased
        };
        context.TasteModelEvalRuns.Add(run);
        await context.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return run;
    }

    private sealed class TimedExample
    {
        public TimedExample(TasteNeuralExample example, Guid userId, DateTime eventUtc, bool isCatalogNegative)
        {
            Example = example;
            UserId = userId;
            EventUtc = eventUtc;
            IsCatalogNegative = isCatalogNegative;
        }

        public TasteNeuralExample Example { get; }

        public Guid UserId { get; }

        public DateTime EventUtc { get; set; }

        public bool IsCatalogNegative { get; }
    }

    private sealed class LabeledMedia
    {
        public LabeledMedia(Guid itemId, bool isPositive, float weight, DateTime eventUtc)
        {
            ItemId = itemId;
            IsPositive = isPositive;
            Weight = weight;
            EventUtc = eventUtc;
        }

        public Guid ItemId { get; }

        public bool IsPositive { get; }

        public float Weight { get; }

        public DateTime EventUtc { get; }
    }
}
