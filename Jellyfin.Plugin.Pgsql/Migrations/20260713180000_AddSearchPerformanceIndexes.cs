using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Jellyfin.Plugin.Pgsql.Migrations
{
    /// <inheritdoc />
    public partial class AddSearchPerformanceIndexes : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql(@"CREATE EXTENSION IF NOT EXISTS pg_trgm;");

            migrationBuilder.Sql(
                @"CREATE INDEX ""IX_BaseItems_CleanName_trgm"" ON ""BaseItems"" USING gin (""CleanName"" gin_trgm_ops);");

            migrationBuilder.Sql(
                @"CREATE INDEX ""IX_BaseItems_OriginalTitle_trgm"" ON ""BaseItems"" USING gin (""OriginalTitle"" gin_trgm_ops);");

            migrationBuilder.Sql(
                @"CREATE INDEX ""IX_Peoples_Name_trgm"" ON ""Peoples"" USING gin (""Name"" gin_trgm_ops);");

            migrationBuilder.Sql(
                @"CREATE INDEX ""IX_BaseItems_SortName_lower"" ON ""BaseItems"" (lower(""SortName"") text_pattern_ops);");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql(@"DROP INDEX IF EXISTS ""IX_BaseItems_SortName_lower"";");
            migrationBuilder.Sql(@"DROP INDEX IF EXISTS ""IX_Peoples_Name_trgm"";");
            migrationBuilder.Sql(@"DROP INDEX IF EXISTS ""IX_BaseItems_OriginalTitle_trgm"";");
            migrationBuilder.Sql(@"DROP INDEX IF EXISTS ""IX_BaseItems_CleanName_trgm"";");
        }
    }
}
