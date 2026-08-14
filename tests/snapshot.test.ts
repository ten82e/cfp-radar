/**
 * Snapshot fallback: SPEC.md section 3.5.
 * Ported from tests/test_snapshot.py.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type BuildArgs, cmdBuild, hooks, setRoot } from "../src/cli.ts";
import { fmtUTC } from "../src/model.ts";
import { makeFixtureCache, NOW_ARG, REPO_ROOT } from "./helpers.ts";

function allUpstreamsDown(): void {
  hooks.collect = async () => ({
    groups: [[], [], []],
    failed: new Set(["ccfddl", "aideadlines"]),
  });
}

function isolatedRepo(): string {
  const root = mkdtempSync("/tmp/cfp-snap-");
  mkdirSync(join(root, "data"), { recursive: true });
  copyFileSync(join(REPO_ROOT, "config.yaml"), join(root, "config.yaml"));
  copyFileSync(join(REPO_ROOT, "data", "overrides.yaml"), join(root, "data", "overrides.yaml"));
  return root;
}

function args(outdir: string, cache?: string): BuildArgs {
  return {
    out: outdir,
    config: "config.yaml",
    offline: true,
    now: NOW_ARG,
    cache: cache ?? join(mkdtempSync("/tmp/cfp-snap-cache-"), ".cache"),
    // 埋め込み生成は 2 モデルで数秒かかるためスナップショット検証ではスキップ
    noEmbeddings: true,
  };
}

describe("snapshot fallback", () => {
  it("build recovers from the snapshot when every source fails", async () => {
    const root = isolatedRepo();
    setRoot(root);
    const snapshot = JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as {
      conferences: unknown[];
    };
    expect(snapshot.conferences.length).toBeGreaterThan(100);
    writeFileSync(join(root, "data", "snapshot.json"), JSON.stringify(snapshot), "utf8");

    allUpstreamsDown();
    const outdir = join(mkdtempSync("/tmp/cfp-snap-out-"), "out");
    const code = await cmdBuild(args(outdir));
    expect(code).toBe(0);

    const data = JSON.parse(readFileSync(join(outdir, "data.json"), "utf8")) as {
      conferences: unknown[];
    };
    expect(data.conferences.length).toBe(snapshot.conferences.length);
  });

  it("degraded builds still apply overrides to the restored snapshot", async () => {
    const root = isolatedRepo();
    setRoot(root);
    const snapshot = JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as {
      conferences: unknown[];
    };
    writeFileSync(join(root, "data", "snapshot.json"), JSON.stringify(snapshot), "utf8");

    allUpstreamsDown();
    const outdir = join(mkdtempSync("/tmp/cfp-snap-out4-"), "out");
    const code = await cmdBuild(args(outdir));
    expect(code).toBe(0);

    const data = JSON.parse(readFileSync(join(outdir, "data.json"), "utf8")) as {
      conferences: Array<{
        key: string;
        editions: Array<{ year: number; estimated: boolean; deadlines: Array<{ utc: string }> }>;
      }>;
    };
    // 退避 snapshot は overrides 未反映の推定版を含むことがある（merge から
    // 次回日次更新までの窓）。上流障害時も data/overrides.yaml の修正が効くこと。
    const ccgrid = data.conferences.find((c) => c.key === "ccgrid");
    const e2027 = ccgrid?.editions.find((e) => e.year === 2027);
    expect(e2027).toBeDefined();
    expect(e2027?.estimated).toBe(false);
    expect(e2027?.deadlines.map((d) => d.utc).sort()).toEqual([
      "2026-11-25T11:59:59Z",
      "2026-12-02T11:59:59Z",
    ]);
  });

  it("degraded builds re-apply the local source onto the restored snapshot", async () => {
    const root = isolatedRepo();
    setRoot(root);
    const snapshot = JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as {
      conferences: unknown[];
    };
    writeFileSync(join(root, "data", "snapshot.json"), JSON.stringify(snapshot), "utf8");

    // 上流障害時も local (data/extra.yaml) は読める。復元 snapshot に無い会議と、
    // snapshot には無い追加締切（satml 2027 通知系など）が配信に残ること。
    // snapshot の satml27 は paper 締切のみ（2026-08-14 時点）。extra.yaml は
    // 通知 3 件を持つ。degraded 復元に local が再適用されれば通知締切が入る。
    hooks.collect = async () => ({
      groups: [
        [],
        [],
        [
          {
            key: "extra-only-conf",
            title: "Extra Only Conf",
            full_name: "Extra Only Conf 2027",
            link: "",
            rank: {},
            dblp: null,
            upstream_sub: null,
            tags: [],
            categories: [],
            editions: [
              {
                year: 2027,
                edition_id: "extra-only-conf27",
                link: "",
                place: "",
                date_text: "2027-03-01..2027-03-03",
                event_start: new Date("2027-03-01T00:00:00Z"),
                event_end: new Date("2027-03-03T00:00:00Z"),
                deadlines: [
                  {
                    kind: "paper",
                    label: "Paper submission",
                    at_utc: new Date("2026-11-04T23:59:59Z"),
                    tz_raw: "America/Los_Angeles",
                    round: 1,
                    comment: null,
                  },
                ],
                estimated: false,
                source: "local",
              },
            ],
            sources: ["local"],
          },
          {
            key: "satml",
            title: "Security and Machine Learning",
            full_name: "Security and Machine Learning",
            link: "",
            rank: {},
            dblp: null,
            upstream_sub: null,
            tags: [],
            categories: [],
            editions: [
              {
                year: 2027,
                edition_id: "satml27",
                link: "",
                place: "",
                date_text: "2027-02-11..2027-02-13",
                event_start: new Date("2027-02-11T00:00:00Z"),
                event_end: new Date("2027-02-13T00:00:00Z"),
                deadlines: [
                  {
                    kind: "notification",
                    label: "Notification to authors",
                    at_utc: new Date("2026-12-16T23:59:59Z"),
                    tz_raw: "America/Los_Angeles",
                    round: 1,
                    comment: null,
                  },
                ],
                estimated: false,
                source: "local",
              },
            ],
            sources: ["local"],
          },
        ],
      ],
      failed: new Set(["ccfddl", "aideadlines"]),
    });

    const outdir = join(mkdtempSync("/tmp/cfp-snap-out8-"), "out");
    const code = await cmdBuild(args(outdir));
    expect(code).toBe(0);

    const data = JSON.parse(readFileSync(join(outdir, "data.json"), "utf8")) as {
      conferences: Array<{
        key: string;
        editions: Array<{
          year: number;
          deadlines: Array<{ utc: string; kind: string }>;
        }>;
      }>;
    };
    // local のみが持つ会議は復元 snapshot に無くても残る
    const extra = data.conferences.find((c) => c.key === "extra-only-conf");
    expect(extra).toBeDefined();
    // snapshot には無い追加締切（通知系）も degraded 配信に残る
    const satml = data.conferences.find((c) => c.key === "satml");
    const e27 = satml?.editions.find((e) => e.year === 2027);
    expect(e27?.deadlines.some((d) => d.kind === "notification")).toBe(true);
  });

  it("build aborts instead of publishing a gutted calendar", async () => {
    const root = isolatedRepo();
    setRoot(root);
    allUpstreamsDown();
    const outdir = join(mkdtempSync("/tmp/cfp-snap-out2-"), "out");
    const code = await cmdBuild(args(outdir));
    expect(code).not.toBe(0);
    expect(existsSync(join(outdir, "all.ics"))).toBe(false);
  });

  it("build aborts when hand-edited data/overrides.yaml is unparsable", async () => {
    const root = isolatedRepo();
    setRoot(root);
    writeFileSync(
      join(root, "data", "overrides.yaml"),
      "conferences:\n  ccgrid: [unclosed\n",
      "utf8",
    );
    const outdir = join(mkdtempSync("/tmp/cfp-snap-out5-"), "out");
    await expect(cmdBuild(args(outdir))).rejects.toThrow(/cannot parse .*overrides\.yaml/);
    expect(existsSync(join(outdir, "all.ics"))).toBe(false);
  });

  it("build aborts when hand-edited config.yaml is unparsable", async () => {
    const root = isolatedRepo();
    setRoot(root);
    writeFileSync(join(root, "config.yaml"), "categories:\n  hpc: [unclosed\n", "utf8");
    const outdir = join(mkdtempSync("/tmp/cfp-snap-out6-"), "out");
    await expect(cmdBuild(args(outdir))).rejects.toThrow(/cannot parse .*config\.yaml/);
    expect(existsSync(join(outdir, "all.ics"))).toBe(false);
  });

  it("auto-generated primary_overrides.yaml keeps warn-and-continue", async () => {
    const root = isolatedRepo();
    setRoot(root);
    const snapshot = JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as {
      conferences: unknown[];
    };
    writeFileSync(join(root, "data", "snapshot.json"), JSON.stringify(snapshot), "utf8");
    writeFileSync(
      join(root, "data", "primary_overrides.yaml"),
      "conferences:\n  whpc: [unclosed\n",
      "utf8",
    );
    // 自動生成ファイルの破損は警告のみで続行（2026-08-12 whpc の趣旨）。
    const outdir = join(mkdtempSync("/tmp/cfp-snap-out7-"), "out");
    const code = await cmdBuild(args(outdir));
    expect(code).toBe(0);
  });

  it("an offline build does not overwrite the snapshot", async () => {
    const root = isolatedRepo();
    setRoot(root);
    const kept = { conferences: [{ key: "sentinel", editions: [] }] };
    const target = join(root, "data", "snapshot.json");
    writeFileSync(target, JSON.stringify(kept), "utf8");

    const cache = makeFixtureCache(mkdtempSync("/tmp/cfp-snap-fix-"));
    const outdir = join(mkdtempSync("/tmp/cfp-snap-out3-"), "out");
    const code = await cmdBuild(args(outdir, cache));
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual(kept);
  });

  it("the real repository's snapshot is untouched by the test suite", () => {
    const live = JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as {
      conferences: unknown[];
    };
    expect(live.conferences.length).toBeGreaterThan(100);
  });

  it("every snapshot deadline's aoe is the UTC-12 wall clock of its utc (R37 guard)", () => {
    const live = JSON.parse(readFileSync(join(REPO_ROOT, "data", "snapshot.json"), "utf8")) as {
      conferences: Array<{
        key: string;
        editions: Array<{ year: number; deadlines: Array<{ utc: string; aoe: string }> }>;
      }>;
    };
    const AOE_MS = 12 * 60 * 60 * 1000;
    let checked = 0;
    for (const conf of live.conferences) {
      for (const ed of conf.editions ?? []) {
        for (const dl of ed.deadlines ?? []) {
          const ms = Date.parse(dl.utc);
          expect(Number.isNaN(ms), `${conf.key}/${ed.year} has bad utc ${dl.utc}`).toBe(false);
          const expected = `${fmtUTC(new Date(ms - AOE_MS), "%Y-%m-%d %H:%M:%S")} AoE`;
          expect(dl.aoe, `${conf.key}/${ed.year} aoe ${dl.aoe} != ${expected}`).toBe(expected);
          checked++;
        }
      }
    }
    // 実データが空になっていないこと（フィクスチャ混入・snapshot 置換の検出）。
    expect(checked).toBeGreaterThan(1000);
  });
});
