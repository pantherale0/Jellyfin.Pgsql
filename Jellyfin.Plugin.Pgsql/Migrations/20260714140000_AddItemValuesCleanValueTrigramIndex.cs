using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Jellyfin.Plugin.Pgsql.Migrations
{
    /// <inheritdoc />
    public partial class AddItemValuesCleanValueTrigramIndex : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql(@"CREATE EXTENSION IF NOT EXISTS pg_trgm;");

            // Speeds up genre/tag contains and optional trigram similarity on ItemValues.CleanValue.
            migrationBuilder.Sql(
                @"CREATE INDEX IF NOT EXISTS ""IX_ItemValues_CleanValue_trgm"" ON ""ItemValues"" USING gin (""CleanValue"" gin_trgm_ops);");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql(@"DROP INDEX IF EXISTS ""IX_ItemValues_CleanValue_trgm"";");
        }
    }
}
