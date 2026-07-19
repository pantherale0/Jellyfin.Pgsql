using System;
using Jellyfin.Database.Implementations;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Jellyfin.Plugin.Pgsql.Migrations
{
    /// <inheritdoc />
    [DbContext(typeof(JellyfinDbContext))]
    [Migration("20260719180000_AddPlaybackActivityPlayMethodAndDaily")]
    public class AddPlaybackActivityPlayMethodAndDaily : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "PlayMethod",
                table: "PlaybackActivity",
                type: "integer",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "TranscodeReasons",
                table: "PlaybackActivity",
                type: "text",
                nullable: true);

            migrationBuilder.Sql(
                """
                UPDATE "PlaybackActivity"
                SET "PlayMethod" = CASE
                    WHEN "PlaybackMethod" LIKE 'DirectPlay%' THEN 2
                    WHEN "PlaybackMethod" LIKE 'DirectStream%' THEN 1
                    WHEN "PlaybackMethod" LIKE 'Transcode%' THEN 0
                    ELSE NULL
                END
                WHERE "PlayMethod" IS NULL AND "PlaybackMethod" IS NOT NULL;
                """);

            migrationBuilder.CreateIndex(
                name: "IX_PlaybackActivity_DatePlayed",
                table: "PlaybackActivity",
                column: "DatePlayed");

            migrationBuilder.CreateIndex(
                name: "IX_PlaybackActivity_DatePlayed_PlayMethod",
                table: "PlaybackActivity",
                columns: new[] { "DatePlayed", "PlayMethod" });

            migrationBuilder.CreateTable(
                name: "PlaybackActivityDaily",
                columns: table => new
                {
                    Date = table.Column<DateTime>(type: "timestamp with time zone", nullable: false),
                    PlayCount = table.Column<int>(type: "integer", nullable: false),
                    TotalTicks = table.Column<long>(type: "bigint", nullable: false),
                    UniqueUsers = table.Column<int>(type: "integer", nullable: false),
                    DirectPlayCount = table.Column<int>(type: "integer", nullable: false),
                    DirectStreamCount = table.Column<int>(type: "integer", nullable: false),
                    TranscodeCount = table.Column<int>(type: "integer", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_PlaybackActivityDaily", x => x.Date);
                });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "PlaybackActivityDaily");

            migrationBuilder.DropIndex(
                name: "IX_PlaybackActivity_DatePlayed_PlayMethod",
                table: "PlaybackActivity");

            migrationBuilder.DropIndex(
                name: "IX_PlaybackActivity_DatePlayed",
                table: "PlaybackActivity");

            migrationBuilder.DropColumn(
                name: "TranscodeReasons",
                table: "PlaybackActivity");

            migrationBuilder.DropColumn(
                name: "PlayMethod",
                table: "PlaybackActivity");
        }
    }
}
