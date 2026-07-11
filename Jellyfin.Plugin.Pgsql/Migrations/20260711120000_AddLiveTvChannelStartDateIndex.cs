using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Jellyfin.Plugin.Pgsql.Migrations
{
    /// <inheritdoc />
    public partial class AddLiveTvChannelStartDateIndex : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateIndex(
                name: "IX_BaseItems_Type_TopParentId_ChannelId_StartDate",
                table: "BaseItems",
                columns: new[] { "Type", "TopParentId", "ChannelId", "StartDate" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_BaseItems_Type_TopParentId_ChannelId_StartDate",
                table: "BaseItems");
        }
    }
}
