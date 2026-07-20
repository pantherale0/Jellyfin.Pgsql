using System;
using Jellyfin.Database.Implementations;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Jellyfin.Plugin.Pgsql.Migrations
{
    /// <inheritdoc />
    [DbContext(typeof(JellyfinDbContext))]
    [Migration("20260720110000_AddPlaybackActivityLiveTvProgramFields")]
    public class AddPlaybackActivityLiveTvProgramFields : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<Guid>(
                name: "ChannelId",
                table: "PlaybackActivity",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "ChannelName",
                table: "PlaybackActivity",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "ShowId",
                table: "PlaybackActivity",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "EpisodeTitle",
                table: "PlaybackActivity",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "Genres",
                table: "PlaybackActivity",
                type: "text",
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_PlaybackActivity_ChannelId_DatePlayed",
                table: "PlaybackActivity",
                columns: new[] { "ChannelId", "DatePlayed" },
                filter: "\"ChannelId\" IS NOT NULL");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_PlaybackActivity_ChannelId_DatePlayed",
                table: "PlaybackActivity");

            migrationBuilder.DropColumn(
                name: "Genres",
                table: "PlaybackActivity");

            migrationBuilder.DropColumn(
                name: "EpisodeTitle",
                table: "PlaybackActivity");

            migrationBuilder.DropColumn(
                name: "ShowId",
                table: "PlaybackActivity");

            migrationBuilder.DropColumn(
                name: "ChannelName",
                table: "PlaybackActivity");

            migrationBuilder.DropColumn(
                name: "ChannelId",
                table: "PlaybackActivity");
        }
    }
}
