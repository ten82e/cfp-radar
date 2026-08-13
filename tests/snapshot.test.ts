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

  it("build aborts instead of publishing a gutted calendar", async () => {
    const root = isolatedRepo();
    setRoot(root);
    allUpstreamsDown();
    const outdir = join(mkdtempSync("/tmp/cfp-snap-out2-"), "out");
    const code = await cmdBuild(args(outdir));
    expect(code).not.toBe(0);
    expect(existsSync(join(outdir, "all.ics"))).toBe(false);
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
