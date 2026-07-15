using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Jellyfin.Plugin.Pgsql.Migrations
{
    /// <inheritdoc />
    public partial class ImproveFuzzyTokenSearchFunction : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql(@"CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;");
            migrationBuilder.Sql(@"CREATE EXTENSION IF NOT EXISTS pg_trgm;");

            // Lowercase + strip punctuation inside SQL so OriginalTitle doesn't need CLR ToLower().
            // Also match against the compacted (space-stripped) haystack for glued CleanName forms.
            migrationBuilder.Sql(
                """
                CREATE OR REPLACE FUNCTION jellyfin_token_levenshtein_match(haystack text, needle text, max_dist integer)
                RETURNS boolean
                LANGUAGE sql
                IMMUTABLE
                STRICT
                AS $func$
                  WITH norm AS (
                    SELECT
                      lower(regexp_replace(coalesce(haystack, ''), '[^[:alnum:]]+', ' ', 'g')) AS h,
                      lower(coalesce(needle, '')) AS n
                  ),
                  tokens AS (
                    SELECT token
                    FROM norm, unnest(string_to_array(norm.h, ' ')) AS token
                    WHERE token <> ''
                  )
                  SELECT CASE
                    WHEN (SELECT n FROM norm) = '' THEN false
                    WHEN EXISTS (
                      SELECT 1
                      FROM tokens
                      WHERE abs(length(token) - length((SELECT n FROM norm))) <= max_dist
                        AND levenshtein_less_equal(token, (SELECT n FROM norm), max_dist) <= max_dist
                    ) THEN true
                    WHEN abs(
                           length(replace((SELECT h FROM norm), ' ', ''))
                           - length((SELECT n FROM norm))
                         ) <= max_dist
                      AND levenshtein_less_equal(
                            replace((SELECT h FROM norm), ' ', ''),
                            (SELECT n FROM norm),
                            max_dist
                          ) <= max_dist
                      THEN true
                    ELSE false
                  END;
                $func$;
                """);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            // Restore the previous simpler implementation from AddFuzzyTokenSearchFunction.
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
    }
}
