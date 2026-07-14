using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Jellyfin.Plugin.Pgsql.Migrations
{
    /// <inheritdoc />
    public partial class AddFuzzyTokenSearchFunction : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql(@"CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;");

            // Token-aware Levenshtein so short typos like gme→game match inside multi-word titles.
            migrationBuilder.Sql(
                """
                CREATE OR REPLACE FUNCTION jellyfin_token_levenshtein_match(haystack text, needle text, max_dist integer)
                RETURNS boolean
                LANGUAGE sql
                IMMUTABLE
                STRICT
                AS $func$
                  SELECT CASE
                    WHEN haystack IS NULL OR needle IS NULL OR needle = '' THEN false
                    WHEN abs(length(haystack) - length(needle)) <= max_dist
                         AND levenshtein_less_equal(haystack, needle, max_dist) <= max_dist THEN true
                    ELSE EXISTS (
                      SELECT 1
                      FROM unnest(string_to_array(haystack, ' ')) AS token
                      WHERE token <> ''
                        AND abs(length(token) - length(needle)) <= max_dist
                        AND levenshtein_less_equal(token, needle, max_dist) <= max_dist
                    )
                  END;
                $func$;
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql(@"DROP FUNCTION IF EXISTS jellyfin_token_levenshtein_match(text, text, integer);");
        }
    }
}
