using System;
using System.Globalization;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Database.Implementations;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Storage;

namespace Jellyfin.Plugin.Pgsql.Search;

/// <summary>
/// Sets <c>pg_trgm.word_similarity_threshold</c> for the current transaction so
/// <c>&lt;%</c> / <see cref="PgSearchDbFunctions.IsWordSimilar"/> can use GIN indexes
/// at a chosen floor. <c>set_config(..., true)</c> is transaction-local and will not
/// leak into the Npgsql pool.
/// </summary>
internal static class PgTrgmThresholdScope
{
    /// <summary>
    /// Begins a transaction and sets the word-similarity threshold.
    /// Dispose (commit) when the queries that need the threshold have finished.
    /// </summary>
    /// <param name="context">Open database context.</param>
    /// <param name="wordSimilarityThreshold">Value for <c>pg_trgm.word_similarity_threshold</c>.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>The transaction; disposing commits it.</returns>
    public static async Task<IDbContextTransaction> BeginAsync(
        JellyfinDbContext context,
        float wordSimilarityThreshold,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(context);

        var transaction = await context.Database.BeginTransactionAsync(cancellationToken).ConfigureAwait(false);
        var threshold = wordSimilarityThreshold.ToString(CultureInfo.InvariantCulture);
        await context.Database.ExecuteSqlInterpolatedAsync(
                $"SELECT set_config('pg_trgm.word_similarity_threshold', {threshold}, true)",
                cancellationToken)
            .ConfigureAwait(false);
        return transaction;
    }
}
