using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations;
using Jellyfin.Plugin.Pgsql.Query;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.ML;

#pragma warning disable SA1402 // Prediction schema is paired with the model store.

namespace Jellyfin.Plugin.Pgsql.Taste;

/// <summary>
/// Loads the latest successful shadow model for live inference.
/// </summary>
public sealed class TasteNeuralModelStore
{
    private readonly IDbContextFactory<JellyfinDbContext> _dbProvider;
    private readonly IQueryResultCache _cache;
    private readonly ILogger<TasteNeuralModelStore> _logger;
    private readonly Lock _gate = new();

    private MLContext? _mlContext;
    private ITransformer? _model;
    private string? _fileName;
    private bool _loaded;

    /// <summary>
    /// Initializes a new instance of the <see cref="TasteNeuralModelStore"/> class.
    /// </summary>
    /// <param name="dbProvider">Database context factory.</param>
    /// <param name="cache">Query result cache (invalidated on model reload).</param>
    /// <param name="logger">Logger.</param>
    public TasteNeuralModelStore(
        IDbContextFactory<JellyfinDbContext> dbProvider,
        IQueryResultCache cache,
        ILogger<TasteNeuralModelStore> logger)
    {
        _dbProvider = dbProvider;
        _cache = cache;
        _logger = logger;
    }

    /// <summary>Gets a value indicating whether a load has been attempted.</summary>
    public bool HasAttemptedLoad
    {
        get
        {
            lock (_gate)
            {
                return _loaded;
            }
        }
    }

    /// <summary>Gets a value indicating whether a model is loaded.</summary>
    public bool IsLoaded
    {
        get
        {
            lock (_gate)
            {
                return _model is not null;
            }
        }
    }

    /// <summary>Gets the loaded model filename, or null.</summary>
    public string? ModelFileName
    {
        get
        {
            lock (_gate)
            {
                return _fileName;
            }
        }
    }

    /// <summary>
    /// Reloads the latest successful model from disk and invalidates recommendation caches.
    /// </summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>A task.</returns>
    public async Task ReloadAsync(CancellationToken cancellationToken)
    {
        var modelDir = TasteModelPaths.ResolveDirectory();
        await using var context = await _dbProvider.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
        var row = await context.TasteModelEvalRuns.AsNoTracking()
            .Where(r => r.ModelPath != null
                && (r.Auc != null || r.Accuracy != null || r.PrecisionAt10 != null))
            .OrderByDescending(r => r.CreatedAt)
            .FirstOrDefaultAsync(cancellationToken)
            .ConfigureAwait(false);

        if (row is null || string.IsNullOrWhiteSpace(row.ModelPath))
        {
            ClearLocked();
            _cache.InvalidateAll();
            return;
        }

        var fileName = Path.GetFileName(row.ModelPath);
        var path = Path.Join(modelDir, fileName);
        try
        {
#pragma warning disable CA3003 // Filename is Path.GetFileName under the plugin taste-models directory.
            if (!File.Exists(path))
            {
                _logger.LogWarning("Taste neural model file missing: {Path}", path);
                ClearLocked();
                _cache.InvalidateAll();
                return;
            }

            var mlContext = new MLContext(seed: 42);
            var model = mlContext.Model.Load(path, out _);
#pragma warning restore CA3003
            lock (_gate)
            {
                _mlContext = mlContext;
                _model = model;
                _fileName = fileName;
                _loaded = true;
            }

            _cache.InvalidateAll();
            if (_logger.IsEnabled(LogLevel.Information))
            {
                _logger.LogInformation("Loaded taste neural model {File}", fileName);
            }
        }
        catch (Exception ex) when (ex is InvalidOperationException or IOException or NotSupportedException
            or UnauthorizedAccessException or ObjectDisposedException)
        {
            _logger.LogWarning(ex, "Failed to load taste neural model {File}", fileName);
            ClearLocked();
            _cache.InvalidateAll();
        }
    }

    /// <summary>
    /// Predicts probabilities for a batch of examples.
    /// </summary>
    /// <param name="examples">Feature rows.</param>
    /// <param name="probabilities">Per-row probabilities when successful.</param>
    /// <returns>True when predictions were produced.</returns>
    public bool TryPredictBatch(IReadOnlyList<TasteNeuralExample> examples, out float[] probabilities)
    {
        probabilities = [];
        if (examples is null || examples.Count == 0)
        {
            return false;
        }

        MLContext? mlContext;
        ITransformer? model;
        lock (_gate)
        {
            mlContext = _mlContext;
            model = _model;
        }

        if (mlContext is null || model is null)
        {
            return false;
        }

        try
        {
            var data = mlContext.Data.LoadFromEnumerable(examples);
            var scored = model.Transform(data);
            var preds = mlContext.Data
                .CreateEnumerable<TasteNeuralPrediction>(scored, reuseRowObject: false)
                .ToList();
            if (preds.Count != examples.Count)
            {
                return false;
            }

            probabilities = preds.Select(p => p.Probability).ToArray();
            return true;
        }
        catch (Exception ex) when (ex is InvalidOperationException or IOException or NotSupportedException
            or ObjectDisposedException)
        {
            _logger.LogWarning(ex, "Taste neural batch predict failed");
            return false;
        }
    }

    private void ClearLocked()
    {
        lock (_gate)
        {
            _mlContext = null;
            _model = null;
            _fileName = null;
            _loaded = true;
        }
    }
}

/// <summary>
/// ML.NET prediction schema for the shadow ranker.
/// </summary>
public sealed class TasteNeuralPrediction
{
    /// <summary>Gets or sets predicted probability of the positive class.</summary>
    public float Probability { get; set; }
}
