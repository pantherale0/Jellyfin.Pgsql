using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Jellyfin.Plugin.Pgsql.Trailers;

/// <summary>
/// Reads an MP4 initialization section and sets its movie duration before it reaches the client.
/// </summary>
internal static class FragmentedMp4Initialization
{
    private const int MaximumBytes = 1024 * 1024;

    public static async Task<byte[]> ReadAndPatchAsync(Stream source, double durationSeconds, CancellationToken cancellationToken)
    {
        if (!double.IsFinite(durationSeconds) || durationSeconds <= 0)
        {
            throw new YtDlpException("yt-dlp did not report a duration for the adaptive trailer.");
        }

        using var initialization = new MemoryStream();
        while (initialization.Length < MaximumBytes)
        {
            var header = new byte[8];
            await source.ReadExactlyAsync(header, cancellationToken).ConfigureAwait(false);
            var size32 = BinaryPrimitives.ReadUInt32BigEndian(header);
            var headerSize = 8;
            ulong atomSize = size32;
            if (size32 == 1)
            {
                var extendedSize = new byte[8];
                await source.ReadExactlyAsync(extendedSize, cancellationToken).ConfigureAwait(false);
                Array.Resize(ref header, 16);
                extendedSize.CopyTo(header, 8);
                headerSize = 16;
                atomSize = BinaryPrimitives.ReadUInt64BigEndian(extendedSize);
            }

            if (size32 == 0 || atomSize < (ulong)headerSize || atomSize > (ulong)(MaximumBytes - initialization.Length))
            {
                throw new YtDlpException("ffmpeg returned an invalid MP4 initialization section.");
            }

            var atom = new byte[checked((int)atomSize)];
            header.CopyTo(atom, 0);
            await source.ReadExactlyAsync(atom.AsMemory(headerSize), cancellationToken).ConfigureAwait(false);
            var type = Encoding.ASCII.GetString(atom, 4, 4);
            if (type == "moov")
            {
                PatchMovieDuration(atom, headerSize, durationSeconds);
            }

            await initialization.WriteAsync(atom, cancellationToken).ConfigureAwait(false);
            if (type == "moov")
            {
                return initialization.ToArray();
            }
        }

        throw new YtDlpException("ffmpeg MP4 initialization section exceeded the size limit.");
    }

    private static void PatchMovieDuration(byte[] moov, int headerSize, double durationSeconds)
    {
        var children = ReadBoxes(moov, headerSize, moov.Length);
        var movieHeader = ExactlyOne(children, "mvhd");
        var movieTimescale = ReadTimescale(moov, movieHeader);
        WriteDuration(moov, movieHeader, durationSeconds, movieTimescale, 16, 24);

        foreach (var track in children.Where(box => box.Type == "trak"))
        {
            var trackChildren = ReadBoxes(moov, track.Offset + track.HeaderSize, track.Offset + track.Size);
            var trackHeader = ExactlyOne(trackChildren, "tkhd");
            WriteDuration(moov, trackHeader, durationSeconds, movieTimescale, 20, 28);

            var media = ExactlyOne(trackChildren, "mdia");
            var mediaChildren = ReadBoxes(moov, media.Offset + media.HeaderSize, media.Offset + media.Size);
            var mediaHeader = ExactlyOne(mediaChildren, "mdhd");
            WriteDuration(moov, mediaHeader, durationSeconds, ReadTimescale(moov, mediaHeader), 16, 24);
        }

        foreach (var movieExtends in children.Where(box => box.Type == "mvex"))
        {
            var extensions = ReadBoxes(moov, movieExtends.Offset + movieExtends.HeaderSize, movieExtends.Offset + movieExtends.Size);
            foreach (var fragmentHeader in extensions.Where(box => box.Type == "mehd"))
            {
                WriteDuration(moov, fragmentHeader, durationSeconds, movieTimescale, 4, 4);
            }
        }
    }

    private static uint ReadTimescale(byte[] bytes, Mp4Box box)
    {
        var version = ReadVersion(bytes, box);
        var offset = box.Offset + box.HeaderSize + (version == 0 ? 12 : 20);
        var timescale = BinaryPrimitives.ReadUInt32BigEndian(bytes.AsSpan(offset, sizeof(uint)));
        if (timescale == 0)
        {
            throw new YtDlpException("ffmpeg returned an invalid MP4 timescale.");
        }

        return timescale;
    }

    private static void WriteDuration(byte[] bytes, Mp4Box box, double seconds, uint timescale, int version0Offset, int version1Offset)
    {
        var version = ReadVersion(bytes, box);
        var ticks = checked((ulong)Math.Ceiling(seconds * timescale));
        var offset = box.Offset + box.HeaderSize + (version == 0 ? version0Offset : version1Offset);
        if (version == 0)
        {
            if (ticks > uint.MaxValue)
            {
                throw new YtDlpException("Trailer duration exceeds the MP4 header limit.");
            }

            BinaryPrimitives.WriteUInt32BigEndian(bytes.AsSpan(offset, sizeof(uint)), (uint)ticks);
            return;
        }

        BinaryPrimitives.WriteUInt64BigEndian(bytes.AsSpan(offset, sizeof(ulong)), ticks);
    }

    private static byte ReadVersion(byte[] bytes, Mp4Box box)
    {
        var version = bytes[box.Offset + box.HeaderSize];
        if (version is not 0 and not 1)
        {
            throw new YtDlpException("ffmpeg returned an unsupported MP4 header version.");
        }

        return version;
    }

    private static Mp4Box ExactlyOne(IReadOnlyList<Mp4Box> boxes, string type)
    {
        Mp4Box? result = null;
        foreach (var box in boxes.Where(box => box.Type == type))
        {
            if (result is not null)
            {
                throw new YtDlpException($"ffmpeg returned multiple {type} atoms.");
            }

            result = box;
        }

        return result ?? throw new YtDlpException($"ffmpeg MP4 initialization is missing {type}.");
    }

    private static List<Mp4Box> ReadBoxes(byte[] bytes, int start, int end)
    {
        var boxes = new List<Mp4Box>();
        for (var offset = start; offset < end;)
        {
            if (end - offset < 8)
            {
                throw new YtDlpException("ffmpeg returned a truncated MP4 atom header.");
            }

            var size32 = BinaryPrimitives.ReadUInt32BigEndian(bytes.AsSpan(offset, sizeof(uint)));
            var headerSize = 8;
            ulong size = size32;
            if (size32 == 1)
            {
                if (end - offset < 16)
                {
                    throw new YtDlpException("ffmpeg returned a truncated extended MP4 atom header.");
                }

                headerSize = 16;
                size = BinaryPrimitives.ReadUInt64BigEndian(bytes.AsSpan(offset + 8, sizeof(ulong)));
            }

            if (size32 == 0 || size < (ulong)headerSize || size > (ulong)(end - offset))
            {
                throw new YtDlpException("ffmpeg returned an invalid MP4 atom size.");
            }

            boxes.Add(new Mp4Box(offset, checked((int)size), headerSize, Encoding.ASCII.GetString(bytes, offset + 4, 4)));
            offset += checked((int)size);
        }

        return boxes;
    }

    private sealed record Mp4Box(int Offset, int Size, int HeaderSize, string Type);
}
