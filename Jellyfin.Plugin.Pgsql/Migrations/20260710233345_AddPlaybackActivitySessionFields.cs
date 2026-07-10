using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Jellyfin.Plugin.Pgsql.Migrations
{
    /// <inheritdoc />
    public partial class AddPlaybackActivitySessionFields : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "ClientName",
                table: "PlaybackActivity",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "DeviceId",
                table: "PlaybackActivity",
                type: "integer",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "DeviceName",
                table: "PlaybackActivity",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "PlaybackMethod",
                table: "PlaybackActivity",
                type: "text",
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_PlaybackActivity_DeviceId",
                table: "PlaybackActivity",
                column: "DeviceId",
                filter: "\"DeviceId\" IS NOT NULL");

            migrationBuilder.CreateIndex(
                name: "IX_PlaybackActivity_ItemId_DatePlayed",
                table: "PlaybackActivity",
                columns: new[] { "ItemId", "DatePlayed" });

            migrationBuilder.CreateIndex(
                name: "IX_PlaybackActivity_UserId_DatePlayed",
                table: "PlaybackActivity",
                columns: new[] { "UserId", "DatePlayed" });

            migrationBuilder.AddForeignKey(
                name: "FK_PlaybackActivity_Devices_DeviceId",
                table: "PlaybackActivity",
                column: "DeviceId",
                principalTable: "Devices",
                principalColumn: "Id",
                onDelete: ReferentialAction.SetNull);

            migrationBuilder.AddForeignKey(
                name: "FK_PlaybackActivity_Users_UserId",
                table: "PlaybackActivity",
                column: "UserId",
                principalTable: "Users",
                principalColumn: "Id",
                onDelete: ReferentialAction.Cascade);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_PlaybackActivity_Devices_DeviceId",
                table: "PlaybackActivity");

            migrationBuilder.DropForeignKey(
                name: "FK_PlaybackActivity_Users_UserId",
                table: "PlaybackActivity");

            migrationBuilder.DropIndex(
                name: "IX_PlaybackActivity_DeviceId",
                table: "PlaybackActivity");

            migrationBuilder.DropIndex(
                name: "IX_PlaybackActivity_ItemId_DatePlayed",
                table: "PlaybackActivity");

            migrationBuilder.DropIndex(
                name: "IX_PlaybackActivity_UserId_DatePlayed",
                table: "PlaybackActivity");

            migrationBuilder.DropColumn(
                name: "ClientName",
                table: "PlaybackActivity");

            migrationBuilder.DropColumn(
                name: "DeviceId",
                table: "PlaybackActivity");

            migrationBuilder.DropColumn(
                name: "DeviceName",
                table: "PlaybackActivity");

            migrationBuilder.DropColumn(
                name: "PlaybackMethod",
                table: "PlaybackActivity");
        }
    }
}
