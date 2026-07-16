using System;
using Jellyfin.Database.Implementations;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Jellyfin.Plugin.Pgsql.Migrations
{
    /// <inheritdoc />
    [DbContext(typeof(JellyfinDbContext))]
    [Migration("20260716140000_AddPlaybackActivitySeriesName")]
    public class AddPlaybackActivitySeriesName : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<Guid>(
                name: "SeriesId",
                table: "PlaybackActivity",
                type: "uuid",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "SeriesName",
                table: "PlaybackActivity",
                type: "text",
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_PlaybackActivity_SeriesId_DatePlayed",
                table: "PlaybackActivity",
                columns: new[] { "SeriesId", "DatePlayed" },
                filter: "\"SeriesId\" IS NOT NULL");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_PlaybackActivity_SeriesId_DatePlayed",
                table: "PlaybackActivity");

            migrationBuilder.DropColumn(
                name: "SeriesId",
                table: "PlaybackActivity");

            migrationBuilder.DropColumn(
                name: "SeriesName",
                table: "PlaybackActivity");
        }
    }
}
