using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Jellyfin.Plugin.Pgsql.Migrations
{
    /// <inheritdoc />
    public partial class RestoreMediaSegmentsItemIdIndex : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // Update_12_0-rc5 dropped this plugin-only index because it is not in the
            // core EF model. Recreate it; OnModelCreating now declares it so later
            // Update_* syncs will not treat it as drift.
            migrationBuilder.Sql(
                """
                CREATE INDEX IF NOT EXISTS "IX_MediaSegments_ItemId"
                ON "MediaSegments" ("ItemId");
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_MediaSegments_ItemId",
                table: "MediaSegments");
        }
    }
}
