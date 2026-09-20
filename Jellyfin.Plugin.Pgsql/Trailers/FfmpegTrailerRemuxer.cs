using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller.MediaEncoding;
using Microsoft.AspNetCore.Http;

namespace Jellyfin.Plugin.Pgsql.Trailers;

/// <summary>
/// Streams separate YouTube video and audio tracks through ffmpeg without temporary files.
/// </summary>
public sealed class FfmpegTrailerRemuxer : ITrailerRemuxer
{
    private const int MaxErrorCharacters = 32 * 1024;
    private static readonly SemaphoreSlim RemuxSlots = new(4, 4);
    private readonly IMediaEncoder _mediaEncoder;

    /// <summary>
    /// Initializes a new instance of the <see cref="FfmpegTrailerRemuxer"/> class.
    /// </summary>
    /// <param name="mediaEncoder">Jellyfin media encoder providing the validated ffmpeg path.</param>
    public FfmpegTrailerRemuxer(IMediaEncoder mediaEncoder)
    {
        _mediaEncoder = mediaEncoder;
    }

    /// <inheritdoc />
    public async Task RelayAsync(YtDlpResolution resolution, HttpContext context, CancellationToken cancellationToken)
    {
        if (!resolution.RequiresRemux || resolution.AudioUrl is null)
        {
            throw new ArgumentException("Adaptive trailer tracks are required.", nameof(resolution));
        }

        await RemuxSlots.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            var startInfo = new ProcessStartInfo
            {
                FileName = _mediaEncoder.EncoderPath,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            AddInput(startInfo, resolution.Url, resolution.Headers);
            AddInput(startInfo, resolution.AudioUrl, resolution.AudioHeaders ?? new Dictionary<string, string>());
            foreach (var argument in new[] { "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "pipe:1" })
            {
                startInfo.ArgumentList.Add(argument);
            }

            using var process = new Process { StartInfo = startInfo };
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

            try
            {
                var errorTask = ReadBoundedAsync(process.StandardError, cancellationToken);
                context.Response.StatusCode = StatusCodes.Status200OK;
                context.Response.ContentType = "video/mp4";
                await process.StandardOutput.BaseStream.CopyToAsync(context.Response.Body, cancellationToken).ConfigureAwait(false);
                await process.WaitForExitAsync(cancellationToken).ConfigureAwait(false);
                _ = await errorTask.ConfigureAwait(false);
                if (process.ExitCode != 0)
                {
                    throw new YtDlpException("Trailer remuxing failed.");
                }
            }
            catch
            {
                TryKill(process);
                throw;
            }
        }
        finally
        {
            RemuxSlots.Release();
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
}
