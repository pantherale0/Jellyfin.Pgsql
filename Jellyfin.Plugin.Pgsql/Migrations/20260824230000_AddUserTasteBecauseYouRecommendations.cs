using System;
using Jellyfin.Database.Implementations;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Jellyfin.Plugin.Pgsql.Migrations
{
    /// <inheritdoc />
    [DbContext(typeof(JellyfinDbContext))]
    [Migration("20260824230000_AddUserTasteBecauseYouRecommendations")]
    public class AddUserTasteBecauseYouRecommendations : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "UserTasteBecauseYouRecommendations",
                columns: table => new
                {
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    SourceItemId = table.Column<Guid>(type: "uuid", nullable: false),
                    Rank = table.Column<int>(type: "integer", nullable: false),
                    SourceKind = table.Column<string>(type: "text", nullable: false),
                    ItemId = table.Column<Guid>(type: "uuid", nullable: false),
                    Score = table.Column<int>(type: "integer", nullable: false),
                    UpdatedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_UserTasteBecauseYouRecommendations", x => new { x.UserId, x.SourceItemId, x.Rank });
                });

            migrationBuilder.CreateIndex(
                name: "IX_UserTasteBecauseYouRecommendations_UserId_SourceKind",
                table: "UserTasteBecauseYouRecommendations",
                columns: new[] { "UserId", "SourceKind" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "UserTasteBecauseYouRecommendations");
        }
    }
}
