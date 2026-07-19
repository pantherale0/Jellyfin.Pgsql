using Jellyfin.Database.Implementations;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Jellyfin.Plugin.Pgsql.Migrations
{
    /// <inheritdoc />
    [DbContext(typeof(JellyfinDbContext))]
    [Migration("20260719210000_AddPeopleProviderKey")]
    public class AddPeopleProviderKey : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "ProviderKey",
                table: "Peoples",
                type: "text",
                nullable: true);

            migrationBuilder.CreateIndex(
                name: "IX_Peoples_ProviderKey",
                table: "Peoples",
                column: "ProviderKey");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropIndex(
                name: "IX_Peoples_ProviderKey",
                table: "Peoples");

            migrationBuilder.DropColumn(
                name: "ProviderKey",
                table: "Peoples");
        }
    }
}
