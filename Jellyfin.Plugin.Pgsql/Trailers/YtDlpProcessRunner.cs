using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.Pgsql.Trailers;

/// <summary>
/// Invokes yt-dlp with bounded output and execution time.
/// </summary>
public sealed class YtDlpProcessRunner : IYtDlpProcessRunner
{
    private const int MaxOutputCharacters = 32 * 1024;
    private static readonly TimeSpan ProcessTimeout = TimeSpan.FromSeconds(30);

    /// <inheritdoc />
    public async Task<YtDlpResolution> ResolveAsync(
        string executablePath,
        string videoId,
        CancellationToken cancellationToken)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = executablePath,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };

        startInfo.ArgumentList.Add("--ignore-config");
        startInfo.ArgumentList.Add("--no-playlist");
        startInfo.ArgumentList.Add("--no-warnings");
        startInfo.ArgumentList.Add("--no-progress");
        startInfo.ArgumentList.Add("--simulate");
        startInfo.ArgumentList.Add("--socket-timeout");
        startInfo.ArgumentList.Add("15");
        startInfo.ArgumentList.Add("--format");
        startInfo.ArgumentList.Add("best[protocol^=http][ext=mp4][vcodec^=avc1][acodec^=mp4a][height<=1080]/bestvideo[protocol^=http][ext=mp4][vcodec^=avc1][height<=1080]+bestaudio[protocol^=http][ext=m4a][acodec^=mp4a]");
        startInfo.ArgumentList.Add("--print");
        startInfo.ArgumentList.Add("%(url)j");
        startInfo.ArgumentList.Add("--print");
        startInfo.ArgumentList.Add("%(http_headers)j");
        startInfo.ArgumentList.Add("--print");
        startInfo.ArgumentList.Add("%(requested_formats.0.url)j");
        startInfo.ArgumentList.Add("--print");
        startInfo.ArgumentList.Add("%(requested_formats.0.http_headers)j");
        startInfo.ArgumentList.Add("--print");
        startInfo.ArgumentList.Add("%(requested_formats.1.url)j");
        startInfo.ArgumentList.Add("--print");
        startInfo.ArgumentList.Add("%(requested_formats.1.http_headers)j");
        startInfo.ArgumentList.Add("https://www.youtube.com/watch?v=" + videoId);

        using var process = new Process { StartInfo = startInfo };
        try
        {
            if (!process.Start())
            {
                throw new YtDlpException("yt-dlp did not start.");
            }
        }
        catch (Exception ex) when (ex is not YtDlpException)
        {
            throw new YtDlpException("yt-dlp is unavailable.", ex);
        }

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(ProcessTimeout);
        try
        {
            var stdoutTask = ReadBoundedAsync(process.StandardOutput, timeout.Token);
            var stderrTask = ReadBoundedAsync(process.StandardError, timeout.Token);
            await process.WaitForExitAsync(timeout.Token).ConfigureAwait(false);
            var stdout = await stdoutTask.ConfigureAwait(false);
            var stderr = await stderrTask.ConfigureAwait(false);

            if (process.ExitCode != 0)
            {
                throw new YtDlpException(string.IsNullOrWhiteSpace(stderr) ? "yt-dlp failed." : "yt-dlp could not resolve the trailer.");
            }

            var lines = stdout.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            if (lines.Length == 2)
            {
                return ParseProgressive(lines[0], lines[1]);
            }

            if (lines.Length != 6)
            {
                throw new YtDlpException("yt-dlp returned an invalid response.");
            }

            if (!string.Equals(lines[0], "NA", StringComparison.Ordinal))
            {
                return ParseProgressive(lines[0], lines[1]);
            }

            var video = ParseResource(lines[2], lines[3]);
            var audio = ParseResource(lines[4], lines[5]);
            return new YtDlpResolution(video.Url, video.Headers, audio.Url, audio.Headers);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            TryKill(process);
            throw new YtDlpException("yt-dlp timed out.");
        }
        catch
        {
            TryKill(process);
            throw;
        }
    }

    private static YtDlpResolution ParseProgressive(string urlJson, string headersJson)
    {
        var resource = ParseResource(urlJson, headersJson);
        return new YtDlpResolution(resource.Url, resource.Headers);
    }

    private static ResolvedResource ParseResource(string urlJson, string headersJson)
    {
        var url = JsonSerializer.Deserialize<string>(urlJson);
        var headers = JsonSerializer.Deserialize<Dictionary<string, string>>(headersJson);
        if (string.IsNullOrWhiteSpace(url)
            || !Uri.TryCreate(url, UriKind.Absolute, out var uri)
            || (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp))
        {
            throw new YtDlpException("yt-dlp returned an invalid stream URL.");
        }

        return new ResolvedResource(url, headers ?? new Dictionary<string, string>());
    }

    private static async Task<string> ReadBoundedAsync(StreamReader reader, CancellationToken cancellationToken)
    {
        var buffer = new char[4096];
        var result = new System.Text.StringBuilder();
        while (true)
        {
            var read = await reader.ReadAsync(buffer.AsMemory(), cancellationToken).ConfigureAwait(false);
            if (read == 0)
            {
                return result.ToString();
            }

            if (result.Length + read > MaxOutputCharacters)
            {
                throw new YtDlpException("yt-dlp output exceeded the allowed size.");
            }

            result.Append(buffer, 0, read);
        }
    }

    private static void TryKill(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }
        }
        catch (InvalidOperationException)
        {
            // The process exited between the check and kill.
        }
    }

    private sealed record ResolvedResource(string Url, IReadOnlyDictionary<string, string> Headers);
}
