using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Jellyfin.Plugin.Pgsql.Migrations
{
    /// <inheritdoc />
    public partial class Update_12_0rc5 : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_PeopleBaseItemMap_PeopleId",
                table: "PeopleBaseItemMap");

            migrationBuilder.DropIndex(
                name: "IX_MediaSegments_ItemId",
                table: "MediaSegments");

            migrationBuilder.CreateIndex(
                name: "IX_PeopleBaseItemMap_PeopleId_ItemId",
                table: "PeopleBaseItemMap",
                columns: new[] { "PeopleId", "ItemId" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_PeopleBaseItemMap_PeopleId_ItemId",
                table: "PeopleBaseItemMap");

            migrationBuilder.CreateIndex(
                name: "IX_PeopleBaseItemMap_PeopleId",
                table: "PeopleBaseItemMap",
                column: "PeopleId");

            migrationBuilder.CreateIndex(
                name: "IX_MediaSegments_ItemId",
                table: "MediaSegments",
                column: "ItemId");
        }
    }
}
