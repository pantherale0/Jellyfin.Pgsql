using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations;
using MediaBrowser.Controller.Persistence;
using MediaBrowser.Model.Tasks;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Pgsql.Taste;

/// <summary>
/// Scheduled rebuild of user taste profiles and optional shadow neural training.
/// </summary>
public sealed class RebuildUserTasteProfilesTask : IScheduledTask, IConfigurableScheduledTask
{
    private readonly IDbContextFactory<JellyfinDbContext> _dbProvider;
    private readonly IItemTypeLookup _itemTypeLookup;
    private readonly UserTasteProfileBuilder _builder;
    private readonly TasteShadowNeuralTrainer _shadowTrainer;
    private readonly UserTasteProfileStore _profileStore;
    private readonly ILogger<RebuildUserTasteProfilesTask> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="RebuildUserTasteProfilesTask"/> class.
    /// </summary>
    /// <param name="dbProvider">Database context factory.</param>
    /// <param name="itemTypeLookup">Item type lookup.</param>
    /// <param name="builder">Profile builder.</param>
    /// <param name="shadowTrainer">Shadow trainer.</param>
    /// <param name="profileStore">Profile cache store.</param>
    /// <param name="logger">Logger.</param>
    public RebuildUserTasteProfilesTask(
        IDbContextFactory<JellyfinDbContext> dbProvider,
        IItemTypeLookup itemTypeLookup,
        UserTasteProfileBuilder builder,
        TasteShadowNeuralTrainer shadowTrainer,
        UserTasteProfileStore profileStore,
        ILogger<RebuildUserTasteProfilesTask> logger)
    {
        _dbProvider = dbProvider;
        _itemTypeLookup = itemTypeLookup;
        _builder = builder;
        _shadowTrainer = shadowTrainer;
        _profileStore = profileStore;
        _logger = logger;
    }

    /// <inheritdoc />
    public string Name => "Rebuild user taste profiles";

    /// <inheritdoc />
    public string Key => "RebuildUserTasteProfiles";

    /// <inheritdoc />
    public string Description =>
        "Aggregates watch and favorite history into per-user taste profiles and optionally trains a shadow recommendation model for offline evaluation.";

    /// <inheritdoc />
    public string Category => "Library";

    /// <inheritdoc />
    public bool IsHidden => false;

    /// <inheritdoc />
    public bool IsEnabled => TasteOptions.Current.EnableTasteProfiles;

    /// <inheritdoc />
    public bool IsLogged => true;

    /// <inheritdoc />
    public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
    {
        yield return new TaskTriggerInfo
        {
            Type = TaskTriggerInfoType.IntervalTrigger,
            IntervalTicks = TimeSpan.FromHours(24).Ticks
        };
    }

    /// <inheritdoc />
    public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
    {
        var options = TasteOptions.Current;
        if (!options.EnableTasteProfiles)
        {
            _logger.LogInformation("Taste profiles disabled; skipping rebuild task");
            progress.Report(100);
            return;
        }

        progress.Report(5);
        var context = await _dbProvider.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
        await using (context.ConfigureAwait(false))
        {
            var upserted = await _builder.RebuildAllAsync(
                    context,
                    _itemTypeLookup,
                    options.LookbackDays,
                    options.MinSamples,
                    cancellationToken)
                .ConfigureAwait(false);
            _profileStore.InvalidateAll();
            progress.Report(60);

            if (options.EnableNeuralShadowTraining)
            {
                try
                {
                    var modelDir = ResolveModelDirectory();
                    await _shadowTrainer.TrainAndEvaluateAsync(
                            context,
                            _itemTypeLookup,
                            modelDir,
                            cancellationToken)
                        .ConfigureAwait(false);
                }
                catch (Exception ex)
                {
                    // Shadow training must never fail the profile rebuild job.
                    _logger.LogWarning(ex, "Shadow taste model training failed; profiles were still updated (count={Count})", upserted);
                }
            }
            else if (_logger.IsEnabled(LogLevel.Information))
            {
                _logger.LogInformation("Shadow neural training disabled; profiles only (count={Count})", upserted);
            }
        }

        progress.Report(100);
    }

    private static string ResolveModelDirectory()
    {
        var root = Plugin.Instance?.DataFolderPath
            ?? Path.Combine(Path.GetTempPath(), "jellyfin-pgsql-taste");
        return Path.Combine(root, "taste-models");
    }
}
