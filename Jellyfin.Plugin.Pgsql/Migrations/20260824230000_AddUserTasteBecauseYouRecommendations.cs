using Jellyfin.Database.Implementations;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Jellyfin.Plugin.Pgsql.Migrations
{
    /// <inheritdoc />
    [DbContext(typeof(JellyfinDbContext))]
    [Migration("20260824230000_AddUserTasteBecauseYouRecommendations")]
    public class AddUserTasteBecauseYouRecommendations : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // Table may already exist when migration history was restored or a prior
            // startup created the relation before recording this migration.
            migrationBuilder.Sql(
                """
                CREATE TABLE IF NOT EXISTS "UserTasteBecauseYouRecommendations" (
                    "UserId" uuid NOT NULL,
                    "SourceItemId" uuid NOT NULL,
                    "Rank" integer NOT NULL,
                    "SourceKind" text NOT NULL,
                    "ItemId" uuid NOT NULL,
                    "Score" integer NOT NULL,
                    "UpdatedAt" timestamp with time zone NOT NULL,
                    CONSTRAINT "PK_UserTasteBecauseYouRecommendations" PRIMARY KEY ("UserId", "SourceItemId", "Rank")
                );

                CREATE INDEX IF NOT EXISTS "IX_UserTasteBecauseYouRecommendations_UserId_SourceKind"
                ON "UserTasteBecauseYouRecommendations" ("UserId", "SourceKind");
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "UserTasteBecauseYouRecommendations");
        }
    }
}
