using System;
using Jellyfin.Database.Implementations;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Jellyfin.Plugin.Pgsql.Migrations
{
    /// <inheritdoc />
    [DbContext(typeof(JellyfinDbContext))]
    [Migration("20260813210000_AddTasteModelEvalRunMetrics")]
    public class AddTasteModelEvalRunMetrics : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "ForYouEngageCount",
                table: "TasteModelEvalRuns",
                type: "integer",
                nullable: true);

            migrationBuilder.AddColumn<double>(
                name: "ForYouEngageRate",
                table: "TasteModelEvalRuns",
                type: "double precision",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "ForYouEngageWindowDays",
                table: "TasteModelEvalRuns",
                type: "integer",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "ForYouImpressionCount",
                table: "TasteModelEvalRuns",
                type: "integer",
                nullable: true);

            migrationBuilder.AddColumn<double>(
                name: "HoldoutFraction",
                table: "TasteModelEvalRuns",
                type: "double precision",
                nullable: true);

            migrationBuilder.AddColumn<DateTime>(
                name: "HoldoutWindowEnd",
                table: "TasteModelEvalRuns",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<DateTime>(
                name: "HoldoutWindowStart",
                table: "TasteModelEvalRuns",
                type: "timestamp with time zone",
                nullable: true);

            migrationBuilder.AddColumn<double>(
                name: "MeanPrecisionAt10",
                table: "TasteModelEvalRuns",
                type: "double precision",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "SplitType",
                table: "TasteModelEvalRuns",
                type: "text",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "TrainCount",
                table: "TasteModelEvalRuns",
                type: "integer",
                nullable: false,
                defaultValue: 0);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "ForYouEngageCount",
                table: "TasteModelEvalRuns");

            migrationBuilder.DropColumn(
                name: "ForYouEngageRate",
                table: "TasteModelEvalRuns");

            migrationBuilder.DropColumn(
                name: "ForYouEngageWindowDays",
                table: "TasteModelEvalRuns");

            migrationBuilder.DropColumn(
                name: "ForYouImpressionCount",
                table: "TasteModelEvalRuns");

            migrationBuilder.DropColumn(
                name: "HoldoutFraction",
                table: "TasteModelEvalRuns");

            migrationBuilder.DropColumn(
                name: "HoldoutWindowEnd",
                table: "TasteModelEvalRuns");

            migrationBuilder.DropColumn(
                name: "HoldoutWindowStart",
                table: "TasteModelEvalRuns");

            migrationBuilder.DropColumn(
                name: "MeanPrecisionAt10",
                table: "TasteModelEvalRuns");

            migrationBuilder.DropColumn(
                name: "SplitType",
                table: "TasteModelEvalRuns");

            migrationBuilder.DropColumn(
                name: "TrainCount",
                table: "TasteModelEvalRuns");
        }
    }
}
