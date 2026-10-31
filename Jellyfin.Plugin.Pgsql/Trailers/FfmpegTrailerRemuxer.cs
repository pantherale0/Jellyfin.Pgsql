using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller.MediaEncoding;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Microsoft.Net.Http.Headers;

namespace Jellyfin.Plugin.Pgsql.Trailers;

/// <summary>
/// Prepares separate YouTube tracks as a seekable MP4 and serves the completed file.
/// </summary>
public sealed class FfmpegTrailerRemuxer : ITrailerRemuxer, IAsyncDisposable
{
    private const int MaxErrorCharacters = 32 * 1024;
    private const int MaxCachedFiles = 8;
    private const long MaxFileBytes = 64L * 1024 * 1024;
    private static readonly TimeSpan CacheTtl = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan PreparationTimeout = TimeSpan.FromMinutes(2);
    private readonly SemaphoreSlim _cacheGate = new(1, 1);
    private readonly Dictionary<string, CachedTrailer> _files = new(StringComparer.Ordinal);
    private readonly IMediaEncoder _mediaEncoder;
    private readonly ILogger<FfmpegTrailerRemuxer> _logger;
    private readonly string _cacheRoot;
    private readonly string _directory;
    private bool _disposed;

    /// <summary>
    /// Initializes a new instance of the <see cref="FfmpegTrailerRemuxer"/> class.
    /// </summary>
    /// <param name="mediaEncoder">Jellyfin media encoder providing the validated ffmpeg path.</param>
    /// <param name="appPaths">Application cache location.</param>
    /// <param name="logger">Logger.</param>
    public FfmpegTrailerRemuxer(IMediaEncoder mediaEncoder, IApplicationPaths appPaths, ILogger<FfmpegTrailerRemuxer> logger)
    {
        _mediaEncoder = mediaEncoder;
        _logger = logger;
        _cacheRoot = Path.Join(appPaths.CachePath, "pgsql-trailers");
        _directory = Path.Join(_cacheRoot, Guid.NewGuid().ToString("N", CultureInfo.InvariantCulture));
    }

    /// <inheritdoc />
    public async Task RelayAsync(YtDlpResolution resolution, HttpContext context, CancellationToken cancellationToken)
    {
        if (!resolution.RequiresRemux || resolution.AudioUrl is null)
        {
            throw new ArgumentException("Adaptive trailer tracks are required.", nameof(resolution));
        }

        ObjectDisposedException.ThrowIf(_disposed, this);
        var key = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(resolution.Url + "\n" + resolution.AudioUrl)));
        if (!await _cacheGate.WaitAsync(PreparationTimeout, cancellationToken).ConfigureAwait(false))
        {
            throw new YtDlpException("Trailer preparation is busy. Try again later.");
        }

        FileStream file;
        CachedTrailer trailer;
        try
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            CleanupOrphanedDirectories();
            foreach (var expired in _files.Where(pair => pair.Value.ExpiresAt <= DateTimeOffset.UtcNow).Select(pair => pair.Key).ToArray())
            {
                RemoveFile(expired);
            }

            if (!_files.TryGetValue(key, out var cached) || !File.Exists(cached.Path))
            {
                _files.Remove(key);
                if (_files.Count >= MaxCachedFiles)
                {
                    RemoveFile(_files.MinBy(pair => pair.Value.ExpiresAt).Key);
                }

                cached = await PrepareAsync(resolution, resolution.AudioUrl, cancellationToken).ConfigureAwait(false);
                _files.Add(key, cached);
            }

            trailer = cached;
            file = new FileStream(trailer.Path, FileMode.Open, FileAccess.Read, FileShare.Read | FileShare.Delete, 64 * 1024, FileOptions.Asynchronous | FileOptions.RandomAccess);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw new YtDlpException("Trailer cache is unavailable.", ex);
        }
        finally
        {
            _cacheGate.Release();
        }

        await using (file.ConfigureAwait(false))
        {
            context.Response.Headers.CacheControl = "private, no-cache";
            await Results.File(file, "video/mp4", entityTag: trailer.EntityTag, enableRangeProcessing: true).ExecuteAsync(context).ConfigureAwait(false);
        }
    }

    /// <inheritdoc />
    public async ValueTask DisposeAsync()
    {
        if (_disposed)
        {
            return;
        }

        await _cacheGate.WaitAsync().ConfigureAwait(false);
        try
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
            foreach (var key in _files.Keys.ToArray())
            {
                RemoveFile(key);
            }

            if (Directory.Exists(_directory))
            {
                try
                {
                    Directory.Delete(_directory);
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    _logger.LogWarning(ex, "Unable to remove a temporary trailer directory");
                }
            }
        }
        finally
        {
            _cacheGate.Release();
        }

        _cacheGate.Dispose();
        GC.SuppressFinalize(this);
    }

    private async Task<CachedTrailer> PrepareAsync(YtDlpResolution resolution, string audioUrl, CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(_directory);
        var path = Path.Join(_directory, Guid.NewGuid().ToString("N", CultureInfo.InvariantCulture) + ".mp4");
        var startInfo = new ProcessStartInfo
        {
            FileName = _mediaEncoder.EncoderPath,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };
        AddInput(startInfo, resolution.Url, resolution.Headers);
        AddInput(startInfo, audioUrl, resolution.AudioHeaders ?? new Dictionary<string, string>());
        foreach (var argument in new[] { "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-fs", MaxFileBytes.ToString(CultureInfo.InvariantCulture), "-movflags", "+faststart", "-f", "mp4", "-y", path })
        {
            startInfo.ArgumentList.Add(argument);
        }

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(PreparationTimeout);
        using var process = new Process { StartInfo = startInfo };
        try
        {
            try
            {
                if (!process.Start())
                {
                    throw new YtDlpException("Trailer remuxer did not start.");
                }
            }
            catch (Exception ex) when (ex is not YtDlpException)
            {
                throw new YtDlpException("Trailer remuxer is unavailable.", ex);
            }

            var errorTask = ReadBoundedAsync(process.StandardError, timeout.Token);
            await process.WaitForExitAsync(timeout.Token).ConfigureAwait(false);
            _ = await errorTask.ConfigureAwait(false);
            if (process.ExitCode != 0)
            {
                throw new YtDlpException("Trailer remuxing failed.");
            }

            await using var output = File.OpenRead(path);
            // ffmpeg may stop at -fs with exit code zero. Reject near-limit output rather than serving a clipped trailer.
            if (output.Length == 0 || output.Length >= MaxFileBytes - (1024 * 1024))
            {
                throw new YtDlpException("Trailer exceeds the allowed cache size or is empty.");
            }

            var digest = await SHA256.HashDataAsync(output, timeout.Token).ConfigureAwait(false);
            return new CachedTrailer(path, DateTimeOffset.UtcNow.Add(CacheTtl), new EntityTagHeaderValue('"' + Convert.ToHexString(digest) + '"'));
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            await StopProcessAsync(process).ConfigureAwait(false);
            DeleteFile(path);
            throw new YtDlpException("Trailer preparation timed out.");
        }
        catch
        {
            await StopProcessAsync(process).ConfigureAwait(false);
            DeleteFile(path);
            throw;
        }
    }

    private void RemoveFile(string key)
    {
        if (_files.Remove(key, out var file))
        {
            DeleteFile(file.Path);
        }
    }

    private void CleanupOrphanedDirectories()
    {
        if (!Directory.Exists(_cacheRoot))
        {
            return;
        }

        var cutoff = DateTime.UtcNow - CacheTtl - PreparationTimeout;
        foreach (var directory in Directory.EnumerateDirectories(_cacheRoot))
        {
            if (directory == _directory
                || !Guid.TryParseExact(Path.GetFileName(directory), "N", out _))
            {
                continue;
            }

            try
            {
                if (Directory.GetLastWriteTimeUtc(directory) > cutoff
                    || (File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0)
                {
                    continue;
                }

                Directory.Delete(directory, recursive: true);
            }
            catch (DirectoryNotFoundException)
            {
                // Another server process already removed the expired directory.
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                _logger.LogWarning(ex, "Unable to remove an expired trailer cache directory");
            }
        }
    }

    private void DeleteFile(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            _logger.LogWarning(ex, "Unable to remove a temporary trailer file");
        }
    }

    private static void AddInput(ProcessStartInfo startInfo, string url, IReadOnlyDictionary<string, string> headers)
    {
        startInfo.ArgumentList.Add("-hide_banner");
        startInfo.ArgumentList.Add("-loglevel");
        startInfo.ArgumentList.Add("error");
        startInfo.ArgumentList.Add("-nostdin");
        startInfo.ArgumentList.Add("-rw_timeout");
        startInfo.ArgumentList.Add("15000000");
        if (headers.Count > 0)
        {
            startInfo.ArgumentList.Add("-headers");
            startInfo.ArgumentList.Add(string.Join("\r\n", headers.Select(pair => pair.Key + ": " + pair.Value)) + "\r\n");
        }

        startInfo.ArgumentList.Add("-i");
        startInfo.ArgumentList.Add(url);
    }

    private static async Task<string> ReadBoundedAsync(StreamReader reader, CancellationToken cancellationToken)
    {
        var buffer = new char[4096];
        var result = new StringBuilder();
        var exceeded = false;
        while (true)
        {
            var read = await reader.ReadAsync(buffer.AsMemory(), cancellationToken).ConfigureAwait(false);
            if (read == 0)
            {
                if (exceeded)
                {
                    throw new YtDlpException("Trailer remuxer output exceeded the allowed size.");
                }

                return result.ToString();
            }

            if (result.Length + read > MaxErrorCharacters)
            {
                exceeded = true;
                continue;
            }

            result.Append(buffer, 0, read);
        }
    }

    private static async Task StopProcessAsync(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                await process.WaitForExitAsync().ConfigureAwait(false);
            }
        }
        catch (InvalidOperationException)
        {
            // The process exited between the check and kill.
        }
    }

    private sealed record CachedTrailer(string Path, DateTimeOffset ExpiresAt, EntityTagHeaderValue EntityTag);
}
