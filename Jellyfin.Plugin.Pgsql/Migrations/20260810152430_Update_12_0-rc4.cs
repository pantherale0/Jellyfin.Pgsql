using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Jellyfin.Plugin.Pgsql.Migrations
{
    /// <inheritdoc />
    public partial class Update_12_0rc4 : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_PlaybackActivity_SeriesId_DatePlayed",
                table: "PlaybackActivity");

            migrationBuilder.DropPrimaryKey(
                name: "PK_LinkedChildren",
                table: "LinkedChildren");

            migrationBuilder.DropIndex(
                name: "IX_LinkedChildren_ParentId_SortOrder",
                table: "LinkedChildren");

            migrationBuilder.AlterColumn<int>(
                name: "SortOrder",
                table: "LinkedChildren",
                type: "integer",
                nullable: false,
                defaultValue: 0,
                oldClrType: typeof(int),
                oldType: "integer",
                oldNullable: true);

            migrationBuilder.AddPrimaryKey(
                name: "PK_LinkedChildren",
                table: "LinkedChildren",
                columns: new[] { "ParentId", "SortOrder" });

            migrationBuilder.CreateIndex(
                name: "IX_BaseItems_PrimaryVersionId",
                table: "BaseItems",
                column: "PrimaryVersionId",
                filter: "\"PrimaryVersionId\" IS NOT NULL");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropPrimaryKey(
                name: "PK_LinkedChildren",
                table: "LinkedChildren");

            migrationBuilder.DropIndex(
                name: "IX_BaseItems_PrimaryVersionId",
                table: "BaseItems");

            migrationBuilder.AlterColumn<int>(
                name: "SortOrder",
                table: "LinkedChildren",
                type: "integer",
                nullable: true,
                oldClrType: typeof(int),
                oldType: "integer");

            migrationBuilder.AddPrimaryKey(
                name: "PK_LinkedChildren",
                table: "LinkedChildren",
                columns: new[] { "ParentId", "ChildId" });

            migrationBuilder.CreateIndex(
                name: "IX_PlaybackActivity_SeriesId_DatePlayed",
                table: "PlaybackActivity",
                columns: new[] { "SeriesId", "DatePlayed" },
                filter: "\"SeriesId\" IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_LinkedChildren_ParentId_SortOrder",
                table: "LinkedChildren",
                columns: new[] { "ParentId", "SortOrder" });
        }
    }
}
