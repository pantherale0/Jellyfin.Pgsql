using System;
using Jellyfin.Database.Implementations;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Jellyfin.Plugin.Pgsql.Migrations
{
    /// <inheritdoc />
    [DbContext(typeof(JellyfinDbContext))]
    [Migration("20260722110000_AddUserTasteRecommendationImpressions")]
    public class AddUserTasteRecommendationImpressions : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "UserTasteRecommendationImpressions",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    UserId = table.Column<Guid>(type: "uuid", nullable: false),
                    ItemId = table.Column<Guid>(type: "uuid", nullable: false),
                    ItemType = table.Column<string>(type: "text", nullable: false),
                    Rank = table.Column<int>(type: "integer", nullable: false),
                    ServedAt = table.Column<DateTime>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_UserTasteRecommendationImpressions", x => x.Id);
                });

            migrationBuilder.CreateIndex(
                name: "IX_UserTasteRecommendationImpressions_UserId_ItemId_ServedAt",
                table: "UserTasteRecommendationImpressions",
                columns: new[] { "UserId", "ItemId", "ServedAt" });

            migrationBuilder.CreateIndex(
                name: "IX_UserTasteRecommendationImpressions_UserId_ServedAt",
                table: "UserTasteRecommendationImpressions",
                columns: new[] { "UserId", "ServedAt" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "UserTasteRecommendationImpressions");
        }
    }
}
