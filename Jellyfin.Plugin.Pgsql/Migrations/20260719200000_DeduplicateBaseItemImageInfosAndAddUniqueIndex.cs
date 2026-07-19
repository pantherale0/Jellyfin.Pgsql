using Jellyfin.Database.Implementations;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Jellyfin.Plugin.Pgsql.Migrations
{
    /// <inheritdoc />
    [DbContext(typeof(JellyfinDbContext))]
    [Migration("20260719200000_DeduplicateBaseItemImageInfosAndAddUniqueIndex")]
    public class DeduplicateBaseItemImageInfosAndAddUniqueIndex : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // Collapse duplicate image rows before the unique index is applied.
            // Prefer rows with dimensions and blurhash populated.
            migrationBuilder.Sql(
                """
                DELETE FROM "BaseItemImageInfos"
                WHERE "Id" IN (
                  SELECT "Id" FROM (
                    SELECT "Id",
                           ROW_NUMBER() OVER (
                             PARTITION BY "ItemId", "ImageType", "Path"
                             ORDER BY
                               CASE WHEN "Width" > 0 AND "Height" > 0 THEN 0 ELSE 1 END,
                               CASE WHEN "Blurhash" IS NOT NULL THEN 0 ELSE 1 END,
                               "Id"
                           ) AS rn
                    FROM "BaseItemImageInfos"
                  ) t WHERE rn > 1
                );
                """);

            migrationBuilder.CreateIndex(
                name: "IX_BaseItemImageInfos_ItemId_ImageType_Path",
                table: "BaseItemImageInfos",
                columns: new[] { "ItemId", "ImageType", "Path" },
                unique: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_BaseItemImageInfos_ItemId_ImageType_Path",
                table: "BaseItemImageInfos");
        }
    }
}
