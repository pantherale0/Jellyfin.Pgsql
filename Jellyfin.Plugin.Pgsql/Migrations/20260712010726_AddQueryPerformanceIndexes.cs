using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Jellyfin.Plugin.Pgsql.Migrations
{
    /// <inheritdoc />
    public partial class AddQueryPerformanceIndexes : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateIndex(
                name: "IX_UserData_UserId_Rating",
                table: "UserData",
                columns: new[] { "UserId", "Rating" },
                filter: "\"Rating\" >= 6.5");

            migrationBuilder.CreateIndex(
                name: "IX_BaseItems_SeriesName_DateCreated",
                table: "BaseItems",
                columns: new[] { "SeriesName", "DateCreated" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_UserData_UserId_Rating",
                table: "UserData");

            migrationBuilder.DropIndex(
                name: "IX_BaseItems_SeriesName_DateCreated",
                table: "BaseItems");
        }
    }
}
