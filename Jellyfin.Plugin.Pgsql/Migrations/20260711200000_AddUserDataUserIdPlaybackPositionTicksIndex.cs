using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Jellyfin.Plugin.Pgsql.Migrations
{
    /// <inheritdoc />
    public partial class AddUserDataUserIdPlaybackPositionTicksIndex : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateIndex(
                name: "IX_UserData_UserId_PlaybackPositionTicks",
                table: "UserData",
                columns: new[] { "UserId", "PlaybackPositionTicks" },
                filter: "\"PlaybackPositionTicks\" > 0");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_UserData_UserId_PlaybackPositionTicks",
                table: "UserData");
        }
    }
}
