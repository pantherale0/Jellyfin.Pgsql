using System;
using System.Collections.Generic;
using System.Data.Common;
using System.Linq;
using System.Text.Json;
using Jellyfin.Plugin.Pgsql.Query;
using Jellyfin.Plugin.Pgsql.Tests.Infrastructure;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Entities;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Xunit;
using Xunit.Abstractions;

namespace Jellyfin.Plugin.Pgsql.Tests.Query;

[Collection(PostgresCollection.Name)]
public sealed class ResumeQueryPlanTests(PostgresDatabaseFixture database, ITestOutputHelper output)
{
    [PostgresTestFact]
    public void Selector_UsesCandidateLookupsAsUnwatchedLibraryGrows()
    {
        using var fixture = new ResumeQueryTestFixture(database);
        for (var i = 1; i <= 9; i++)
        {
            fixture.AddItem(i);
            fixture.AddProgress(i, i);
            fixture.AddProgress(i, i);
            if (i < 9)
            {
                fixture.AddProgress(i, i);
            }
        }

        fixture.AddUnrelatedItems(1000, 1000);
        AssertCandidatePlan(fixture);
        fixture.AddUnrelatedItems(20000, 2000);
        AssertCandidatePlan(fixture);
        var result = fixture.Selector().TryGetItems(fixture.Query());
        Assert.NotNull(result);
        Assert.Equal(Enumerable.Range(1, 9).Reverse().Select(fixture.Id), result.Items.Select(i => i.Id));
        Assert.Equal(9, result.TotalRecordCount);
    }

    [PostgresTestFact]
    public void Hydration_LoadsRequestedDetailsOnlyForPageIds()
    {
        var capture = new CaptureCommands();
        using var fixture = new ResumeQueryTestFixture(database, capture);
        for (var i = 1; i <= 3; i++)
        {
            fixture.AddItem(i);
            fixture.AddProgress(i, i);
        }

        var query = fixture.Query();
        query.Limit = 2;
        query.DtoOptions.EnableImages = true;
        query.DtoOptions.EnableUserData = true;
        fixture.AddProgress(3, 3, fixture.AddUser().Id);
        using (var context = fixture.Factory.CreateDbContext())
        {
            context.BaseItemImageInfos.Add(new BaseItemImageInfo
            {
                Id = Guid.NewGuid(), ItemId = fixture.Id(3), Item = null!,
                Path = "/resume-image.jpg",
            });
            context.LinkedChildren.Add(new LinkedChildEntity
            {
                ParentId = fixture.Id(3), ChildId = fixture.Id(1),
                ChildType = Jellyfin.Database.Implementations.Entities.LinkedChildType.LinkedAlternateVersion,
            });
            context.SaveChanges();
        }

        capture.Commands.Clear();
        var result = fixture.Selector().TryGetItems(query);
        Assert.NotNull(result);
        Assert.Equal([fixture.Id(3), fixture.Id(2)], result.Items.Select(i => i.Id));
        Assert.Equal("/resume-image.jpg", Assert.Single(result.Items[0].ImageInfos).Path);
        var userData = Assert.Single(result.Items[0].UserData);
        Assert.Equal(fixture.User.Id, userData.UserId);
        Assert.Equal(100, userData.PlaybackPositionTicks);
        Assert.Equal(fixture.Id(1), Assert.Single(Assert.IsAssignableFrom<Video>(result.Items[0]).LinkedAlternateVersions).ItemId);
        Assert.NotEmpty(capture.Commands);
        foreach (var table in new[] { "BaseItemImageInfos", "UserData", "LinkedChildren" })
        {
            Assert.Contains(capture.Commands, c => c.Sql.Contains(table, StringComparison.Ordinal));
        }

        Assert.All(capture.Commands, command =>
        {
            Assert.Contains(command.Ids, ids => ids.Length == 2 && ids.Contains(fixture.Id(2)) && ids.Contains(fixture.Id(3)));
            Assert.DoesNotContain("WITH progress", command.Sql, StringComparison.OrdinalIgnoreCase);
            Assert.DoesNotContain("AncestorIds", command.Sql, StringComparison.Ordinal);
        });
    }

    private void AssertCandidatePlan(ResumeQueryTestFixture fixture)
    {
        using var context = fixture.Factory.CreateDbContext();
        context.Database.OpenConnection();
        context.Database.ExecuteSqlRaw("SET jit = off; ANALYZE \"BaseItems\"; ANALYZE \"UserData\"");
        var query = fixture.Query();
        Assert.True(ResumeQueryFilter.TryCreate(query, out var translated));
        using var command = fixture.Selector().CreateSelectionCommand(context, query, translated);
        command.CommandText = "EXPLAIN (ANALYZE, BUFFERS, SETTINGS, FORMAT JSON) " + command.CommandText;
        using var reader = command.ExecuteReader();
        Assert.True(reader.Read());
        using var document = JsonDocument.Parse(reader.GetString(0));
        var root = document.RootElement[0];
        var baseScans = Nodes(root.GetProperty("Plan")).Where(n =>
            n.TryGetProperty("Relation Name", out var relation) && relation.GetString() == "BaseItems").ToArray();
        Assert.NotEmpty(baseScans);
        Assert.All(baseScans, scan =>
        {
            Assert.NotEqual("Seq Scan", scan.GetProperty("Node Type").GetString());
            var loops = scan.GetProperty("Actual Loops").GetDouble();
            var filtered = scan.TryGetProperty("Rows Removed by Filter", out var removed) ? removed.GetDouble() : 0;
            var rechecked = scan.TryGetProperty("Rows Removed by Index Recheck", out var recheck) ? recheck.GetDouble() : 0;
            var visited = (scan.GetProperty("Actual Rows").GetDouble() + filtered + rechecked) * loops;
            Assert.True(visited <= 9, scan.ToString());
            Assert.True(scan.TryGetProperty("Index Cond", out var condition)
                && condition.GetString()!.Contains("\"Id\" =", StringComparison.Ordinal), scan.ToString());
        });
        output.WriteLine("Planning: {0} ms; execution: {1} ms; BaseItems scan nodes: {2}",
            root.GetProperty("Planning Time"), root.GetProperty("Execution Time"), baseScans.Length);
    }

    private static IEnumerable<JsonElement> Nodes(JsonElement node)
    {
        yield return node;
        if (node.TryGetProperty("Plans", out var children))
        {
            foreach (var child in children.EnumerateArray().SelectMany(Nodes))
            {
                yield return child;
            }
        }
    }

    private sealed class CaptureCommands : DbCommandInterceptor
    {
        public List<(string Sql, Guid[][] Ids)> Commands { get; } = [];

        public override InterceptionResult<DbDataReader> ReaderExecuting(
            DbCommand command, CommandEventData eventData, InterceptionResult<DbDataReader> result)
        {
            Commands.Add((command.CommandText, command.Parameters.Cast<DbParameter>()
                .Select(p => p.Value).OfType<Guid[]>().Select(ids => ids.ToArray()).ToArray()));
            return result;
        }
    }
}
