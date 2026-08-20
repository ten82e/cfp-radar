/**
 * End-to-end build from tests/fixtures/ only: SPEC.md sections 4 and 8.
 * Ported from tests/test_build_golden.py.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import { beforeAll, expect, it } from "vitest";
import type { HealthReport } from "../src/build.ts";
import {
  buildAll,
  DEFAULT_CATEGORIES,
  embeddingsStale,
  escapeMdCell,
  escapeMdUrl,
  evaluateHealthGate,
  healthMarkdown,
  healthReport,
  ROOT,
  recordsOf,
  setRoot,
  titleWithYear,
  toJson,
  toLlmsTxt,
  toUpcomingMd,
} from "../src/build.ts";
import { main as cliMain, parseArgs as parseCliArgs, usage } from "../src/cli.ts";
import {
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
  EMBEDDING_MULTI_MODEL,
  embeddingManifest,
  main as embeddingsMain,
  profileTexts,
  venuePapersHash,
} from "../src/embeddings.ts";
import {
  makeConference,
  makeDeadline,
  makeEdition,
  NOW,
  PUBLIC_FILES,
  REPO_ROOT,
  runCli,
  utc,
} from "./helpers.ts";

let site: string;
let data: Record<string, any>;

beforeAll(() => {
  const outdir = join(mkdtempSync(join(tmpdir(), "cfp-site-")), "public");
  // 埋め込み生成は 2 モデル（英語+多言語）で数秒かかるため、このテスト群ではスキップ
  const run = runCli(outdir, { extra: ["--no-embeddings"] });
  expect(
    run.status,
    `cli build failed\n--- stdout ---\n${run.stdout}\n--- stderr ---\n${run.stderr}`,
  ).toBe(0);
  site = outdir;
  data = JSON.parse(readFileSync(join(site, "data.json"), "utf8"));
}, 300_000);

it("healthReport separates future confirmed and estimated values", () => {
  const report = healthReport(
    {
      generated_at: "2026-08-09T00:00:00Z",
      sources: [{ name: "ccfddl" }],
      conferences: [
        {
          key: "confirmed",
          categories: ["systems"],
          editions: [{ estimated: false, deadlines: [{ utc: "2026-09-01T00:00:00Z" }] }],
        },
        {
          key: "estimated",
          categories: ["systems", "hpc"],
          editions: [{ estimated: true, deadlines: [{ utc: "2026-10-01T00:00:00Z" }] }],
        },
        {
          key: "past",
          categories: ["systems"],
          editions: [{ estimated: false, deadlines: [{ utc: "2026-08-08T00:00:00Z" }] }],
        },
      ],
    },
    NOW,
    {
      sourceStatus: { ccfddl: "failed" },
      parseWarnings: { malformed: 2 },
      outputFiles: { "data.json": { bytes: 10, sha256: "a".repeat(64) } },
    },
  );
  expect(report).toMatchObject({
    schema_version: 1,
    generated_at: "2026-08-09T00:00:00Z",
    source_status: { ccfddl: "failed" },
    tracked_venues: 3,
    future_confirmed_venues: 1,
    future_estimated_venues: 1,
    confirmed_deadlines: 1,
    estimated_deadlines: 1,
    parse_warnings: { malformed: 2 },
    category_distribution: { hpc: 1, systems: 3 },
    output_files: { "data.json": { bytes: 10, sha256: "a".repeat(64) } },
  });
  expect(healthMarkdown(report)).toContain("| Confirmed deadlines | 1 |");
  expect(healthMarkdown(report)).toContain("| data.json | 10 |");
});

it("toJson preserves deadline evidence, conflicts, and selection rule", () => {
  const payload = toJson(
    [
      makeConference({
        key: "rtss",
        title: "RTSS",
        sources: ["aideadlines", "ccfddl"],
        editions: [
          makeEdition({
            year: 2026,
            source: "aideadlines",
            deadlines: [
              {
                ...makeDeadline("paper", "Paper submission", utc(2026, 9, 1)),
                raw_value: "September 1, 2026 23:59 UTC",
                conflicts: [
                  {
                    at_utc: utc(2026, 8, 31),
                    label: "Paper deadline",
                    source: "ccfddl",
                    raw_value: "2026-08-31T23:59:00Z",
                  },
                ],
              },
            ],
          }),
        ],
      }),
    ],
    {
      sources: [
        { name: "aideadlines", url: "https://example.org/aideadlines" },
        { name: "ccfddl", url: "https://example.org/ccfddl" },
      ],
    },
    NOW,
  );
  const deadline = (payload.conferences as any[])[0].editions[0].deadlines[0];
  expect(deadline.selection_rule).toBe("source_priority_then_nearest_within_configured_window");
  expect(deadline.evidence[0]).toMatchObject({
    source_name: "aideadlines",
    source_url: "https://example.org/aideadlines",
    observed_at: "2026-08-09T00:00:00Z",
    original_value: "September 1, 2026 23:59 UTC",
    confidence: "aggregator",
  });
  expect(deadline.conflicts[0]).toMatchObject({
    at_utc: "2026-08-31T00:00:00Z",
    original_value: "2026-08-31T23:59:00Z",
    evidence: {
      source_name: "ccfddl",
      source_url: "https://example.org/ccfddl",
      confidence: "aggregator",
    },
  });
});

it("evaluateHealthGate covers normal updates and every fail-closed regression", () => {
  const previous: HealthReport = {
    schema_version: 1,
    generated_at: "2026-08-09T00:00:00Z",
    profile_hash: "profile-a",
    source_status: { ccfddl: "success" },
    source_failures: [],
    tracked_venues: 10,
    future_confirmed_venues: 8,
    future_estimated_venues: 2,
    confirmed_deadlines: 10,
    estimated_deadlines: 2,
    confirmed_future_deadlines: 10,
    estimated_future_deadlines: 2,
    venues_with_confirmed_future_deadline: 8,
    snapshot_fallback: false,
    parse_warnings: { one: 1 },
    parse_warning_count: 1,
    category_distribution: { systems: 5 },
    category_counts: { systems: 5 },
    required_venues: { rtss: "present" },
    output_files: {},
  };
  expect(evaluateHealthGate(previous, previous).ok).toBe(true);
  expect(
    evaluateHealthGate(
      { ...previous, confirmed_future_deadlines: 6, confirmed_deadlines: 6 },
      previous,
    ).ok,
  ).toBe(false);
  expect(
    evaluateHealthGate({ ...previous, required_venues: { rtss: "missing" } }, previous).ok,
  ).toBe(false);
  expect(
    evaluateHealthGate(
      { ...previous, parse_warning_count: 8, parse_warnings: { one: 8 } },
      previous,
    ).ok,
  ).toBe(false);
  expect(evaluateHealthGate({ ...previous, profile_hash: "profile-b" }, previous).ok).toBe(false);
  expect(
    evaluateHealthGate(
      { ...previous, source_failures: ["ccfddl"], source_status: { ccfddl: "failed" } },
      previous,
    ).ok,
  ).toBe(false);
  expect(
    evaluateHealthGate(
      {
        ...previous,
        source_failures: ["ccfddl"],
        source_status: { ccfddl: "failed" },
        snapshot_fallback: true,
      },
      previous,
    ).ok,
  ).toBe(true);
  expect(
    evaluateHealthGate(
      { ...previous, estimated_future_deadlines: 0, estimated_deadlines: 0 },
      previous,
    ).ok,
  ).toBe(true);
  expect(
    evaluateHealthGate({ ...previous, generated_at: "2026-08-08T00:00:00Z" }, previous).ok,
  ).toBe(false);
});

it("generated health files describe the deterministic build", () => {
  const report = JSON.parse(readFileSync(join(site, "health.json"), "utf8"));
  expect(report).toMatchObject({
    schema_version: 1,
    generated_at: "2026-08-09T00:00:00Z",
    tracked_venues: data.conferences.length,
    source_status: { ccfddl: "success", aideadlines: "success", local: "success" },
  });
  const dataBytes = readFileSync(join(site, "data.json"));
  expect(report.output_files["data.json"]).toEqual({
    bytes: dataBytes.byteLength,
    sha256: createHash("sha256").update(dataBytes).digest("hex"),
  });
  expect(readFileSync(join(site, "health.md"), "utf8")).toContain("# Build health");
});

// --- generated file set ----------------------------------------------------

it.each(PUBLIC_FILES)("public file is generated: %s", (name) => {
  const path = join(site, name);
  expect(require("node:fs").existsSync(path), `${name} missing from public/`).toBe(true);
  if (name !== ".nojekyll") {
    expect(require("node:fs").statSync(path).size, `${name} is empty`).toBeGreaterThan(0);
  }
});

it("build is deterministic", () => {
  const second = join(mkdtempSync(join(tmpdir(), "cfp-site2-")), "public2");
  const run = runCli(second, { extra: ["--no-embeddings"] });
  expect(run.status, run.stderr).toBe(0);
  for (const name of PUBLIC_FILES) {
    expect(readFileSync(join(site, name))).toEqual(readFileSync(join(second, name)));
  }
}, 300_000);

it("publishes the same browser runtime that the site typecheck validates", () => {
  expect(readFileSync(join(site, "app.js"))).toEqual(
    readFileSync(join(REPO_ROOT, "site", "app.js")),
  );
});

// --- data.json -------------------------------------------------------------

it("data.json has the spec top-level shape", () => {
  for (const key of ["generated_at", "site", "sources", "categories", "conferences"]) {
    expect(key in data).toBe(true);
  }
  expect(data.generated_at).toBe("2026-08-09T00:00:00Z");
  expect(typeof data.site).toBe("object");
  expect(data.site?.domain).toBeDefined();
  expect(data.site?.base_url).toBeDefined();
  expect(typeof data.categories).toBe("object");
  for (const cat of ["hpc", "networking", "systems", "ai", "security"]) {
    expect(cat in data.categories).toBe(true);
  }
  expect(Array.isArray(data.sources) && data.sources.length > 0).toBe(true);
  for (const src of data.sources) {
    for (const key of ["name", "repo", "license"]) {
      expect(key in src).toBe(true);
    }
  }
});

it("conference records match the spec", () => {
  expect(data.conferences.length).toBeGreaterThan(0);
  for (const conf of data.conferences) {
    for (const key of [
      "key",
      "title",
      "full_name",
      "categories",
      "rank",
      "link",
      "sources",
      "editions",
    ]) {
      expect(key in conf).toBe(true);
    }
    expect(Array.isArray(conf.categories)).toBe(true);
    expect(typeof conf.rank).toBe("object");
    expect(Array.isArray(conf.sources) && conf.sources.length > 0).toBe(true);
    for (const s of conf.sources) {
      expect(["ccfddl", "aideadlines", "local"]).toContain(s);
    }
  }
});

it("edition and deadline records match the spec", () => {
  let seenDeadline = false;
  for (const conf of data.conferences) {
    for (const ed of conf.editions) {
      for (const key of [
        "year",
        "id",
        "place",
        "link",
        "event_start",
        "event_end",
        "estimated",
        "deadlines",
      ]) {
        expect(key in ed).toBe(true);
      }
      expect(typeof ed.year).toBe("number");
      expect(typeof ed.estimated).toBe("boolean");
      for (const key of ["event_start", "event_end"]) {
        if (ed[key] !== null) {
          expect(String(ed[key])).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        }
      }
      for (const dl of ed.deadlines) {
        seenDeadline = true;
        for (const key of ["kind", "label", "utc", "aoe", "tz_raw", "round"]) {
          expect(key in dl).toBe(true);
        }
        expect([
          "abstract",
          "paper",
          "supplementary",
          "notification",
          "camera_ready",
          "rebuttal_start",
          "rebuttal_end",
          "review_release",
          "registration",
          "other",
        ]).toContain(dl.kind);
        expect(dl.utc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
        expect(String(dl.aoe).endsWith("AoE")).toBe(true);
        expect(typeof dl.round).toBe("number");
        expect(dl.round).toBeGreaterThanOrEqual(1);
      }
    }
  }
  expect(seenDeadline).toBe(true);
});

function conf(key: string): any {
  const matches = data.conferences.filter((c: any) => c.key === key);
  expect(matches.length).toBeGreaterThan(0);
  return matches[0];
}

it("expected fixture conferences are present", () => {
  const keys = new Set(data.conferences.map((c: any) => c.key));
  for (const key of ["sigcomm", "nsdi", "sc"]) {
    expect(keys.has(key)).toBe(true);
  }
});

it("out-of-scope upstream conferences are filtered out", () => {
  const keys = new Set(data.conferences.map((c: any) => c.key));
  expect(keys.has("prcv")).toBe(true);
  for (const key of ["popl", "oopsla", "aplas"]) {
    expect(keys.has(key)).toBe(false);
  }
});

it("ccfddl plain deadline becomes a paper deadline", () => {
  const sc26 = conf("sc").editions.filter((e: any) => e.id === "sc26")[0];
  const kinds = new Set(sc26.deadlines.map((d: any) => d.kind));
  expect(kinds.has("paper")).toBe(true);
  expect(kinds.has("abstract")).toBe(true);
});

it("AoE boundary is converted in the generated data", () => {
  const sc26 = conf("sc").editions.filter((e: any) => e.id === "sc26")[0];
  const paper = sc26.deadlines.filter((d: any) => d.kind === "paper");
  expect(paper.length).toBeGreaterThan(0);
  expect(paper[0].utc).toBe("2026-04-09T11:59:00Z");
  expect(String(paper[0].tz_raw).toLowerCase()).toBe("aoe");
  expect(String(paper[0].aoe).startsWith("2026-04-08 23:59")).toBe(true);
});

it("free-text event dates are parsed", () => {
  const sigcomm26 = conf("sigcomm").editions.filter((e: any) => e.id === "sigcomm26")[0];
  expect(sigcomm26.event_start).toBe("2026-08-17");
  expect(sigcomm26.event_end).toBe("2026-08-21");
});

it("multiple rounds are preserved", () => {
  const nsdi27 = conf("nsdi").editions.filter((e: any) => e.id === "nsdi27")[0];
  const rounds = new Set(nsdi27.deadlines.map((d: any) => `${d.kind}:${d.round}`));
  expect(rounds.has("paper:1")).toBe(true);
  expect(rounds.has("paper:2")).toBe(true);
});

it("unparseable deadline is skipped not fatal", () => {
  const keys = new Set(data.conferences.map((c: any) => c.key));
  if (!keys.has("acl")) return;
  const editions: Record<string, any> = {};
  for (const e of conf("acl").editions) editions[e.id] = e;
  if ("acl27" in editions) {
    expect(editions.acl27.deadlines).toEqual([]);
  }
});

it("no deadline is in the far future by accident", () => {
  for (const c of data.conferences) {
    for (const ed of c.editions) {
      for (const dl of ed.deadlines) {
        const t = Date.parse(dl.utc);
        expect(t).toBeGreaterThanOrEqual(Date.parse("2015-01-01T00:00:00Z"));
        expect(t).toBeLessThanOrEqual(Date.parse("2032-01-01T00:00:00Z"));
      }
    }
  }
});

// --- other artefacts -------------------------------------------------------

it("CSV is one row per deadline", () => {
  const text = readFileSync(join(site, "data.csv"), "utf8");
  const rows = text.trim().split("\n").slice(1);
  expect(rows.length).toBeGreaterThan(0);
  let total = 0;
  let estimated = 0;
  for (const c of data.conferences) {
    for (const ed of c.editions) {
      total += ed.deadlines.length;
      if (ed.estimated) estimated += ed.deadlines.length;
    }
  }
  expect([total, total - estimated]).toContain(rows.length);
});

it("upcoming.md is a table", () => {
  const text = readFileSync(join(site, "upcoming.md"), "utf8");
  expect(text).toContain("|");
  expect(text).toMatch(/^\|?\s*-{3,}/m);
});

it("llms.txt indexes generated outputs", () => {
  const text = readFileSync(join(site, "llms.txt"), "utf8");
  for (const name of ["data.json", "health.json", "data.csv", "upcoming.md"]) {
    expect(text).toContain(name);
  }
  expect(text).not.toMatch(/\.ics/);
});

it("README links every machine-readable output file (data.csv regression)", () => {
  // #245: README「機械可読の出力」の案内で data.csv だけが URL 無しだった。
  // llms.txt / data.json / upcoming.md / data.csv を案内する。
  // この節の対象読者は「エージェントや自作の道具」— まさに URL を必要とする層。
  const config = (loadYaml(readFileSync(join(REPO_ROOT, "config.yaml"), "utf8")) ?? {}) as Record<
    string,
    any
  >;
  const base = String(config.site?.base_url ?? "").replace(/\/+$/, "");
  expect(base).toBeTruthy();
  const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
  for (const name of ["data.json", "data.csv", "upcoming.md", "llms.txt"]) {
    expect(readme, `README must link the machine-readable output ${name}`).toContain(
      `${base}/${name}`,
    );
  }
});

it("llms.txt URLs match the published site", () => {
  const config = (loadYaml(readFileSync(join(REPO_ROOT, "config.yaml"), "utf8")) ?? {}) as Record<
    string,
    any
  >;
  const base = String(config.site?.base_url ?? "").replace(/\/+$/, "");
  expect(base).toBeTruthy();
  const urls = readFileSync(join(site, "llms.txt"), "utf8")
    .split("\n")
    .filter((l) => l.startsWith("- http"))
    .map((l) => l.slice(2).split(" ", 1)[0]);
  expect(urls.length).toBe(0);
  for (const u of urls) {
    expect(u.startsWith(`${base}/`)).toBe(true);
  }
  const readme = join(REPO_ROOT, "README.md");
  try {
    const text = readFileSync(readme, "utf8");
    for (const name of ["data.json", "llms.txt"]) {
      expect(text).toContain(`${base}/${name}`);
    }
  } catch {
    // README が無い場合はスキップ
  }
});

it("llms.txt title follows config site.title (not a stale hard-coded name)", () => {
  // ビルド成果の先頭行が config.yaml の site.title と一致する（旧名 conf-deadlines ではない）
  const config = (loadYaml(readFileSync(join(REPO_ROOT, "config.yaml"), "utf8")) ?? {}) as Record<
    string,
    any
  >;
  const title = String(config.site?.title ?? "");
  expect(title).toBeTruthy();
  const text = readFileSync(join(site, "llms.txt"), "utf8");
  expect(text.split("\n")[0]).toBe(`# ${title}`);
  expect(text).not.toContain("# conf-deadlines");
  // デッドコンフィグ再発防止: カスタム site.title が toLlmsTxt の出力に反映される
  const custom = toLlmsTxt({
    site: { title: "custom-site" },
    categories: {},
  });
  expect(custom.split("\n")[0]).toBe("# custom-site");
});

it("llms.txt schema summary documents every key data.json actually emits (site/papers/url)", () => {
  // #237: data.json は site（トップレベル）・papers（会議ごと）・sources[].url を
  // 出力しており、golden test も data.site の存在を検証しているが、llms.txt の
  // スキーマ要約（と SPEC §4.2）はこれらを記載していなかった。
  // エージェントは llms.txt を「最初に読む索引」として使うため、実出力との
  // 乖離をここで回帰検査する。
  const text = readFileSync(join(site, "llms.txt"), "utf8");
  const summary = text.slice(text.indexOf("## data.json のスキーマ要約"));
  // トップレベル site キー（base_url が公開 URL の基準）
  expect(summary).toMatch(/- site: object — \{domain: string, base_url: string\}/);
  expect(summary).toMatch(/base_url/);
  // 出典の url キー
  expect(summary).toMatch(/- sources: array of \{name, repo, license, url\}/);
  // 会議ごとの papers キー
  expect(summary).toMatch(/ {2}- papers: array of string/);
  // 実出力との整合: トップレベルキーは全て要約に現れる
  for (const key of Object.keys(data)) {
    expect(summary).toContain(key);
  }
  // 会議レベルのキーは全て要約に現れる
  for (const key of Object.keys(data.conferences[0] ?? {})) {
    expect(summary).toContain(key);
  }
});

it("README documents every build CLI flag (--no-embeddings regression)", () => {
  // #239: README の build オプション表が --no-embeddings を記載しておらず、
  // usage() / テストだけが知っている状態だった。README はユーザーが最初に読む
  // 文書で、実装（src/cli.ts の usage()）が機械可読契約である。
  // ここでは usage() の build セクションに現れる全 --flag が README に
  // 記載されていることを検証し、将来のフラグ追加・削除の乖離を検出する。
  const lines = usage().split("\n");
  const buildStart = lines.findIndex((l) => l.trim().startsWith("build "));
  const buildEnd = lines.findIndex((l, i) => i > buildStart && l.trim().startsWith("discover "));
  expect(buildStart).toBeGreaterThanOrEqual(0);
  expect(buildEnd).toBeGreaterThan(buildStart);
  const flags = [
    ...new Set(
      lines.slice(buildStart, buildEnd).flatMap((l) => l.match(/--[a-z][a-z0-9-]*/g) ?? []),
    ),
  ];
  expect(flags.length).toBeGreaterThan(0);
  const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
  for (const flag of flags) {
    expect(readme, `README must document the build flag ${flag}`).toContain(flag);
  }
});

it("README documents every discover CLI flag (--categories/--min-year regression)", () => {
  // #247: usage() の discover セクションは 5 つのオプション（--out / --categories /
  // --min-year / --dry-run / --append）を定義するが、README の探索セクションは
  // --dry-run / --out / --append しか記載しておらず、--categories と --min-year が
  // 未記載だった（update.yml は --min-year 2026 を実際に使っている）。
  // ここでは discover セクションの全 --flag が README に現れることを検証する
  // （#239 の build 版テストと同じパターンの discover 版）。
  const lines = usage().split("\n");
  const discStart = lines.findIndex((l) => l.trim().startsWith("discover "));
  const discEnd = lines.findIndex((l, i) => i > discStart && l.trim().startsWith("review "));
  expect(discStart).toBeGreaterThanOrEqual(0);
  expect(discEnd).toBeGreaterThan(discStart);
  const flags = [
    ...new Set(lines.slice(discStart, discEnd).flatMap((l) => l.match(/--[a-z][a-z0-9-]*/g) ?? [])),
  ];
  expect(flags).toContain("--categories");
  expect(flags).toContain("--min-year");
  const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
  for (const flag of flags) {
    expect(readme, `README must document the discover flag ${flag}`).toContain(flag);
  }
});

it("README documents every CLI command (review command regression)", () => {
  // #243: usage() は build / discover / review の 3 機能コマンドを定義するが、
  // README は build と discover しか記載しておらず、候補を締切昇順・重複・
  // predatory 疑い付きで一覧する review コマンドが完全に未記載だった
  // （README の「候補の昇格手順」は候補を選ぶ手順を書くのに一覧手段を案内していない）。
  // ここでは usage() の全コマンド（help を除く）が README に現れることを検証し、
  // 将来のコマンド追加・削除の乖離を検出する（#239 のフラグ版テストのコマンド版）。
  const commands = usage()
    .split("\n")
    .map((l) => /^ {2}([a-z][a-z0-9-]*) /.exec(l)?.[1])
    .filter((c): c is string => Boolean(c) && c !== "help");
  expect(commands).toContain("build");
  expect(commands).toContain("discover");
  expect(commands).toContain("review");
  const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
  for (const cmd of commands) {
    expect(readme, `README must document the CLI command ${cmd}`).toContain(cmd);
  }
});

it("SPEC §3.7 documents every CLI command and flag from usage() (#374)", () => {
  const spec = readFileSync(join(REPO_ROOT, "SPEC.md"), "utf8");
  const section = spec.slice(spec.indexOf("### 3.7 "), spec.indexOf("## 4. "));
  expect(section.length).toBeGreaterThan(0);
  const lines = usage().split("\n");
  const commands = lines
    .map((l) => /^ {2}([a-z][a-z0-9-]*) /.exec(l)?.[1])
    .filter((c): c is string => Boolean(c) && c !== "help");
  expect(commands).toEqual(["build", "discover", "review"]);
  for (const cmd of commands) {
    expect(section, `SPEC §3.7 must document the CLI command ${cmd}`).toContain(cmd);
  }
  const flags = [...new Set(lines.flatMap((l) => l.match(/--[a-z][a-z0-9-]*/g) ?? []))].filter(
    (f) => f !== "--help",
  );
  expect(flags).toContain("--no-embeddings");
  for (const flag of flags) {
    expect(section, `SPEC §3.7 must document the CLI flag ${flag}`).toContain(flag);
  }
});

it("SPEC §3.7 documents parseNow TZ and T24:00 fail-closed (#404)", () => {
  const spec = readFileSync(join(REPO_ROOT, "SPEC.md"), "utf8");
  const section = spec.slice(spec.indexOf("### 3.7 "), spec.indexOf("## 4. "));
  expect(section).toMatch(/offset|タイムゾーン|timezone/i);
  expect(section).toMatch(/T24:00|24:00/);
  expect(section).toMatch(/日付だけ|date-only|YYYY-MM-DD/);
});

it("SPEC §2 tree documents every src / site / data yaml / scripts ts file (#378/#380)", () => {
  const spec = readFileSync(join(REPO_ROOT, "SPEC.md"), "utf8");
  const section = spec.slice(spec.indexOf("## 2."), spec.indexOf("## 3."));
  const fenceStart = section.indexOf("```");
  const fenceEnd = section.indexOf("```", fenceStart + 3);
  const tree = section.slice(fenceStart, fenceEnd);
  expect(tree.length).toBeGreaterThan(0);
  const names = [
    ...readdirSync(join(REPO_ROOT, "src")).filter((f) => f.endsWith(".ts")),
    ...readdirSync(join(REPO_ROOT, "src", "sources")).filter((f) => f.endsWith(".ts")),
    ...readdirSync(join(REPO_ROOT, "site")),
    ...readdirSync(join(REPO_ROOT, "data")).filter((f) => /\.ya?ml$/i.test(f)),
    ...readdirSync(join(REPO_ROOT, "scripts")).filter((f) => f.endsWith(".ts")),
  ];
  expect(names).toContain("bench-recommender.ts");
  expect(names).toContain("recommender.js");
  expect(names).toContain("primary.yaml");
  expect(names).toContain("compare-head.ts");
  for (const name of names) {
    expect(tree, `SPEC §2 must list ${name}`).toContain(name);
  }
});

it("SPEC §4 documents every file a standard build generates (embeddings.json/recommender.js regression)", () => {
  // #241: SPEC §4 の生成物一覧が embeddings.json と recommender.js を記載しておらず、
  // 標準 build（node src/cli.ts build --out public）が生成する 2 ファイルが目録から
  // 欠落していた。SPEC は実装の正であり、§4 の表は生成物の正準目録なので、
  // 生成される全ファイルが §4 節に現れることをここで回帰検査する。
  // （buildAll が書く .nojekyll は PUBLIC_FILES に含まれないが、§4 には既に記載済み。）
  const spec = readFileSync(join(REPO_ROOT, "SPEC.md"), "utf8");
  const section4 = spec.slice(spec.indexOf("## 4. 生成物"), spec.indexOf("## 5."));
  expect(section4.length).toBeGreaterThan(0);
  const generated = [...PUBLIC_FILES, "embeddings.json", "recommender.js"];
  for (const name of generated) {
    expect(section4, `SPEC §4 must document the generated file ${name}`).toContain(name);
  }
});

it("index.html has the data injected", () => {
  const text = readFileSync(join(site, "index.html"), "utf8");
  expect(text).not.toContain("/*__DATA__*/null");
  expect(text).toContain("conferences");
  expect(readFileSync(join(site, "app.js"), "utf8")).toContain("__KAMIYOBI_DATA__");
});

it("build splits catalog, recommendation, and historical payloads (#468)", () => {
  const catalog = JSON.parse(readFileSync(join(site, "catalog.json"), "utf8"));
  const recommendation = JSON.parse(readFileSync(join(site, "recommendation-index.json"), "utf8"));
  expect(catalog.history_ref).toBe("data.json");
  expect(catalog.recommendation_ref).toBe("recommendation-index.json");
  expect(catalog.conferences[0]).not.toHaveProperty("papers");
  expect(recommendation.embedding_ref).toBe("embeddings.json");
  expect(recommendation.conferences[0]).toHaveProperty("papers");
  expect(recommendation.conferences[0].editions.every((e: any) => e.deadlines.length <= 1)).toBe(
    true,
  );
  expect(readFileSync(join(site, "index.html"), "utf8")).not.toContain('"papers":');
  expect(data.conferences.length).toBeGreaterThanOrEqual(catalog.conferences.length);
});

it("generated_at follows the --now argument", () => {
  const other = join(mkdtempSync(join(tmpdir(), "cfp-site3-")), "public3");
  const run = runCli(other, { now: "2027-01-02T00:00:00Z", extra: ["--no-embeddings"] });
  expect(run.status, run.stderr).toBe(0);
  const payload = JSON.parse(readFileSync(join(other, "data.json"), "utf8"));
  expect(payload.generated_at).toBe("2027-01-02T00:00:00Z");
  expect(payload.generated_at).not.toBe(data.generated_at);
  expect(NOW.toISOString()).toBe("2026-08-09T00:00:00.000Z");
}, 300_000);

// --- meeting-only conferences keep dates; site table stays paper-only (SPEC §7/§8) ---

it("conferences without deadlines keep their meeting dates", () => {
  for (const key of ["isc-hpc", "hoti", "apnoms"]) {
    const c = conf(key);
    const dated = c.editions.filter((e: any) => e.event_start);
    expect(dated.length).toBeGreaterThan(0);
    for (const ed of dated) {
      expect(ed.deadlines.length).toBe(0);
    }
  }
});

it("index.html has no meeting rows", () => {
  const html =
    readFileSync(join(site, "index.html"), "utf8") +
    "\n" +
    readFileSync(join(site, "app.js"), "utf8");
  expect(html).not.toContain('event: "開催"');
  expect(html).toContain("KIND_LABEL[r.kind]");
  expect(html).toMatch(/r\.kind !== "abstract" && r\.kind !== "paper"/);
  for (const title of ["ISC High Performance", "HOTI", "情報処理学会 HPC 研究会"]) {
    expect(html).toContain(title);
  }
});

it("SPEC §8 no longer claims meeting-only conferences appear as index.html rows (#372)", () => {
  const spec = readFileSync(join(REPO_ROOT, "SPEC.md"), "utf8");
  const section8 = spec.slice(spec.indexOf("## 8."), spec.indexOf("## 9."));
  expect(section8).not.toMatch(/開催回が index\.html に届いている/);
  expect(section8).toMatch(/index\.html has no meeting rows/);
  expect(section8).toMatch(/upcoming\.md/);
});

it("index.html 7d preset uses a real 7-day window", () => {
  const html =
    readFileSync(join(site, "index.html"), "utf8") +
    "\n" +
    readFileSync(join(site, "app.js"), "utf8");
  // 「締切直近 (7日以内)」プリセットは 7 日窓で動作し、ドロップダウンに 7d がある
  expect(html).toContain("applyPreset('7d')");
  expect(html).toContain("if (type === '7d') state.win = \"7d\";");
  expect(html).toContain('value="7d">直近 7 日以内</option>');
  // 30 日窓への偽代入が残っていない（回帰防止）
  expect(html).not.toContain("if (type === '7d') state.win = \"30d\";");
});

it("index.html has domestic filter and tag", () => {
  const html =
    readFileSync(join(site, "index.html"), "utf8") +
    "\n" +
    readFileSync(join(site, "app.js"), "utf8");
  expect(html).toContain('id="domestic"');
  expect(html).toContain("domestic-jp");
  expect(html).toContain('textContent = "国内"');
  expect(html).toContain('p.get("domestic") === "1"');
  for (const title of [
    "情報処理学会 OS 研究会",
    "電子情報通信学会 NS 研究会",
    "電子情報通信学会 IA 研究会",
    "電子情報通信学会 CQ 研究会",
    "電子情報通信学会 ICM 研究会",
    "APNOMS",
    "FIT",
  ]) {
    expect(html).toContain(title);
  }
});

// --- coincident deadlines are told apart (SPEC.md 3.6) ---------------------

it("coincident deadlines get distinguishable titles", async () => {
  const at = utc(2026, 9, 21, 22, 0, 0);
  const confs = [
    makeConference({
      key: "acm-siggraph",
      title: "SIGGRAPH",
      categories: ["ai"],
      sources: ["aideadlines"],
      editions: [
        makeEdition({
          year: 2026,
          edition_id: "siggraph26",
          source: "aideadlines",
          deadlines: [
            makeDeadline("paper", "Posters deadline", at),
            makeDeadline("paper", "Appy Hour deadline", at),
            makeDeadline("paper", "Technical Papers deadline", utc(2026, 10, 22, 22, 0, 0)),
          ],
        }),
      ],
    }),
  ];
  const records = recordsOf(confs);
  expect(records.map((r) => r.kind_label).sort()).toEqual(
    ["論文締切", "論文締切: Appy Hour deadline", "論文締切: Posters deadline"].sort(),
  );
});

it("title ending with the edition year is not duplicated in SUMMARY/upcoming", async () => {
  const at = utc(2026, 12, 1, 22, 0, 0);
  const confs = [
    makeConference({
      key: "canopie-hpc-2026",
      title: "CANOPIE-HPC 2026",
      categories: ["hpc"],
      sources: ["aideadlines"],
      editions: [
        makeEdition({
          year: 2026,
          edition_id: "canopie-hpc-2026-2026",
          source: "aideadlines",
          deadlines: [makeDeadline("paper", "Submission", at)],
        }),
      ],
    }),
    // タイトルに年が無い会議は従来どおり「タイトル + 年」
    makeConference({
      key: "plain-conf",
      title: "PLAIN",
      categories: ["hpc"],
      sources: ["aideadlines"],
      editions: [
        makeEdition({
          year: 2026,
          edition_id: "plain-conf-2026",
          source: "aideadlines",
          deadlines: [makeDeadline("paper", "Submission", utc(2026, 12, 2, 22, 0, 0))],
        }),
      ],
    }),
  ];
  const upcoming = toUpcomingMd(recordsOf(confs), NOW);
  expect(upcoming).toContain("[CANOPIE-HPC 2026](http");
  expect(upcoming).not.toContain("[CANOPIE-HPC 2026 2026]");
  expect(upcoming).toContain("[PLAIN 2026](");
});

it("embeddingsStale は profile と manifest の不一致を再生成する", () => {
  const make = (keys: string[]) => {
    const data = {
      categories: {},
      conferences: keys.map((key) => ({
        key,
        title: key,
        full_name: key,
        categories: [],
        tags: [],
      })),
    };
    const probe = new Array(EMBEDDING_DIM).fill(0);
    const manifest = embeddingManifest(data, { en: probe, multi: probe });
    return {
      data,
      file: {
        model: EMBEDDING_MODEL,
        dim: EMBEDDING_DIM,
        venuePapersHash: venuePapersHash(),
        embeddings: Object.fromEntries(keys.map((k) => [k, probe])),
        multi: {
          model: EMBEDDING_MULTI_MODEL,
          dim: EMBEDDING_DIM,
          embeddings: Object.fromEntries(keys.map((k) => [k, probe])),
        },
        paperVecs: {},
        manifest,
      },
    };
  };
  const emb = (keys: string[]) => make(keys);
  const fresh = emb(["a", "b", "c"]);
  // 同一キー集合 → stale でない
  expect(embeddingsStale(fresh.file, fresh.data)).toBe(false);

  const paperData = {
    categories: {},
    conferences: [
      {
        key: "rtss",
        title: "RTSS",
        full_name: "Real-Time Systems Symposium",
        categories: [],
        tags: [],
      },
    ],
  };
  const paperProbe = new Array(EMBEDDING_DIM).fill(0);
  const paperFile = {
    model: EMBEDDING_MODEL,
    dim: EMBEDDING_DIM,
    venuePapersHash: venuePapersHash(),
    embeddings: { rtss: paperProbe },
    multi: { model: EMBEDDING_MULTI_MODEL, dim: EMBEDDING_DIM, embeddings: { rtss: paperProbe } },
    paperVecs: { rtss: [paperProbe, paperProbe.slice()] },
    manifest: embeddingManifest(paperData, { en: paperProbe, multi: paperProbe }),
  };
  // paperVecs は flat vector map ではなく、複数の paper vector を持つ nested map。
  expect(embeddingsStale(paperFile, paperData)).toBe(false);
  expect(
    embeddingsStale(
      {
        ...paperFile,
        manifest: { ...paperFile.manifest, runtime_version: "old-runtime" },
      },
      paperData,
    ),
  ).toBe(true);
  expect(embeddingsStale({ ...paperFile, paperVecs: { rtss: paperProbe } }, paperData)).toBe(true);
  expect(
    embeddingsStale(
      { ...paperFile, paperVecs: { rtss: [paperProbe, paperProbe.slice(0, -1)] } },
      paperData,
    ),
  ).toBe(true);

  // 数が同じでもキーが入れ替わったら stale（数比較だと見逃す）
  expect(embeddingsStale(fresh.file, emb(["a", "b", "d"]).data)).toBe(true);
  expect(embeddingsStale(fresh.file, emb(["a", "c", "b"]).data)).toBe(false); // 順序は無関係
  // 数が変わったら stale
  expect(embeddingsStale(fresh.file, emb(["a", "b"]).data)).toBe(true);
  expect(embeddingsStale(emb(["a", "b"]).file, fresh.data)).toBe(true);
  // プロファイルの title/full_name/tags/category 変更も stale
  const changed = structuredClone(fresh.data);
  changed.conferences[0].title = "changed";
  expect(embeddingsStale(fresh.file, changed)).toBe(true);
  // manifest / multilingual / model metadata が無い旧形式は stale
  // embeddings が無い既存データ → stale
  expect(embeddingsStale({}, fresh.data)).toBe(true);
  expect(embeddingsStale({ ...fresh.file, manifest: undefined }, fresh.data)).toBe(true);
  expect(embeddingsStale({ ...fresh.file, multi: undefined }, fresh.data)).toBe(true);
  expect(embeddingsStale({ ...fresh.file, model: "wrong" }, fresh.data)).toBe(true);
  expect(
    embeddingsStale(
      {
        ...fresh.file,
        manifest: {
          ...fresh.file.manifest,
          models: {
            ...fresh.file.manifest.models,
            en: { ...fresh.file.manifest.models.en, revision: "wrong" },
          },
        },
      },
      fresh.data,
    ),
  ).toBe(true);
});

it("workflow keeps recommendation failure optional while protecting Pages publication", () => {
  const workflow = readFileSync(join(REPO_ROOT, ".github/workflows/update.yml"), "utf8");
  expect(workflow).toContain("--no-embeddings");
  expect(workflow).toContain("embeddingBundleKey");
  expect(workflow).toContain("actions/cache/restore@v4");
  expect(workflow).toContain("actions/cache/save@v4");
  expect(workflow).toContain("embeddingsStale");
  expect(workflow).toContain("steps.restore-recommendation.outputs.cache-hit != 'true'");
  expect(workflow).toMatch(
    /name: Generate recommendation bundle[\s\S]*?continue-on-error: true[\s\S]*?run: node src\/embeddings\.ts/,
  );
  expect(workflow).toMatch(
    /name: Validate recommendation bundle[\s\S]*?if: \$\{\{ always\(\) && steps\.build\.outcome == 'success' \}\}[\s\S]*?continue-on-error: true[\s\S]*?rmSync\("public\/embeddings\.json"/,
  );
  expect(workflow).toContain("if: $" + "{{ always() && steps.build.outcome == 'success' }}");
  expect(workflow).toContain("always() && steps.validate-recommendation.outcome == 'success'");
  expect(workflow).toContain(
    "always() && steps.validate-recommendation.outcome == 'success' && steps.restore-recommendation.outputs.cache-hit != 'true'",
  );
  expect(workflow).toContain(
    "!cancelled() && steps.build.outcome == 'success' && steps.health-gate.outcome == 'success'",
  );
  expect(workflow).not.toContain(
    "steps.build.outcome == 'success' && steps.validate-recommendation.outcome == 'success' && steps.health-gate.outcome == 'success'",
  );
});

it("CI keeps required verification offline and live discovery optional", () => {
  const ci = readFileSync(join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
  const testJob = ci.slice(ci.indexOf("  test:\n"), ci.indexOf("\n  # 実際の上流"));
  const smokeJob = ci.slice(ci.indexOf("  # 実際の上流"));
  const discover = readFileSync(join(REPO_ROOT, ".github/workflows/discover.yml"), "utf8");

  expect(testJob).toContain("npm test");
  expect(testJob).toContain("--offline");
  expect(testJob).toContain("--no-embeddings");
  expect(testJob).toContain("Check offline result");
  expect(testJob).not.toContain("src/cli.ts discover");
  expect(smokeJob).toContain("continue-on-error: true");
  expect(smokeJob).toContain("--no-embeddings");
  expect(smokeJob).not.toContain("--now 2026-08-09");
  expect(smokeJob).toContain("source_status");
  expect(discover).toContain(
    "node src/cli.ts discover --candidate-out data/discovered_candidates.yaml",
  );
});

it("DEFAULT_CATEGORIES contains all 9 taxonomy domains", () => {
  const expectedDomains = [
    "hpc",
    "networking",
    "systems",
    "ai",
    "security",
    "db",
    "graphics",
    "hci",
    "theory",
  ];
  for (const domain of expectedDomains) {
    expect(DEFAULT_CATEGORIES[domain]).toBeTruthy();
  }
});

// --- upcoming.md carries meetings too (SPEC.md 4) --------------------------

function upcomingRows(dir: string): string[][] {
  const text = readFileSync(join(dir, "upcoming.md"), "utf8");
  const rows: string[][] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("|") || new Set(line).isSubsetOf(new Set("|- "))) continue;
    rows.push(
      line
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim()),
    );
  }
  return rows.slice(1);
}

it("upcoming.md lists meetings as well as deadlines", () => {
  const rows = upcomingRows(site);
  const kinds = new Set(rows.map((r) => r[3]));
  expect(kinds.has("開催")).toBe(true);
  const names = rows
    .filter((r) => r[3] === "開催")
    .map((r) => r[2])
    .join(" ");
  for (const title of [
    "HOTI 2026",
    "SC 2026",
    "情報処理学会 HPC 研究会 2026",
    "P4 Workshop 2026",
    "LPC 2026",
  ]) {
    expect(names).toContain(title);
  }
});

it("upcoming.md keeps a running meeting and drops a finished one", async () => {
  const meeting = (key: string, start: Date, end: Date) =>
    makeConference({
      key,
      title: key.toUpperCase(),
      categories: ["hpc"],
      sources: ["local"],
      editions: [
        makeEdition({
          year: 2026,
          edition_id: `${key}26`,
          source: "local",
          event_start: start,
          event_end: end,
        }),
      ],
    });
  const confs = [
    meeting("running", utc(2026, 8, 7), utc(2026, 8, 11)),
    meeting("lastday", utc(2026, 8, 5), utc(2026, 8, 9)),
    meeting("finished", utc(2026, 8, 1), utc(2026, 8, 8)),
    meeting("future", utc(2026, 8, 19), utc(2026, 8, 21)),
  ];
  const outdir = mkdtempSync(join(tmpdir(), "cfp-mtg-"));
  await buildAll(confs, { categories: { hpc: "HPC" } }, outdir, NOW, { noEmbeddings: true });
  // 回帰ガード: noEmbeddings が第5引数で効いていれば埋め込みは生成されない
  expect(existsSync(join(outdir, "embeddings.json"))).toBe(false);
  const text = readFileSync(join(outdir, "upcoming.md"), "utf8");
  expect(text).toContain("開催中(残り3日)");
  expect(text).not.toContain("| 本日開催 |");
  expect(text).toContain("開催中(残り1日)");
  expect(text).not.toContain("FINISHED");
  expect(text).toContain("| 10日 |");
});

// --- the site's meeting rows run to the end of the meeting (SPEC.md 7) -----

function jsFunction(html: string, name: string): string {
  const start = html.indexOf(`function ${name}(`);
  let depth = 0;
  let i = html.indexOf("{", start);
  while (true) {
    if (html[i] === "{") depth += 1;
    else if (html[i] === "}") {
      depth -= 1;
      if (depth === 0) return html.slice(start, i + 1);
    }
    i += 1;
  }
}

it("default filter shows only submission deadlines", () => {
  const html =
    readFileSync(join(site, "index.html"), "utf8") +
    "\n" +
    readFileSync(join(site, "app.js"), "utf8");
  const filterSrc = jsFunction(html, "filter");
  const script = [
    "const DAY = 86400000;",
    `const FILTER = ${JSON.stringify(filterSrc)};`,
    'const now = Date.parse("2026-08-10T00:00:00Z");',
    // filter() は実時刻 (Date.now()) と行の t を比較するため、凍結した now を
    // 返す FakeDate を注入する。実時刻に依存させると実行日が進んだだけで
    // 行が全て「過去」になり [] に化ける（2026-08-11 に実測）。
    "class FakeDate extends Date { static now() { return now; } }",
    "function row(kind) {",
    "  return {",
    "    kind: kind, est: false, cats: ['hpc'], rankPairs: [], hay: 'x',",
    "    t: now + 86400000, tLast: now + 2 * 86400000, ed: { deadlines: [] }",
    "  };",
    "}",
    'const rows = ["paper", "abstract", "event", "notification", "camera_ready"].map(row);',
    'const state = { q: "", cats: [], kind: "", rank: "", win: "all", est: false };',
    'const filter = new Function("Date", "DAY", "rows", "state", "sortAsc", "sortKey",',
    '                            "return (" + FILTER + ")")(FakeDate, DAY, rows, state, false, "time");',
    "console.log(JSON.stringify(filter().map(r => r.kind)));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  expect(JSON.parse(proc.stdout)).toEqual(["paper", "abstract"]);
});

it("recommendation filter ignores deadline-only state", () => {
  const html =
    readFileSync(join(site, "index.html"), "utf8") +
    "\n" +
    readFileSync(join(site, "app.js"), "utf8");
  const filterSrc = jsFunction(html, "filter");
  const script = [
    "const DAY = 86400000;",
    `const FILTER = ${JSON.stringify(filterSrc)};`,
    'const now = Date.parse("2026-08-10T00:00:00Z");',
    "class FakeDate extends Date { static now() { return now; } }",
    "const paper = { value: '' };",
    "const document = {};",
    "function $(id) { return id === 'paperText' ? paper : null; }",
    "const window = {};",
    "function row(hay, t, rank, cats, tags) {",
    "  return { kind: 'paper', est: false, cats, rankPairs: [rank], hay, tags, t, tLast: t, ed: { deadlines: [] } };",
    "}",
    "const rows = [",
    "  row('topic', now + 86400000, 'A', ['hpc'], ['domestic-jp']),",
    "  row('other', now + 30 * 86400000, 'B', ['systems'], []),",
    "];",
    "const state = { mode: 'deadlines', q: 'topic', cats: ['hpc'], kind: 'paper', rank: 'A', win: '1', est: false, domestic: true, past: false };",
    "const filter = new Function('Date', 'DAY', 'rows', 'state', 'sortAsc', 'sortKey',",
    "  'return (' + FILTER + ')')(FakeDate, DAY, rows, state, true, 'rem');",
    "const deadline = filter().length;",
    "state.mode = 'recommend';",
    "paper.value = 'topic';",
    "const recommend = filter().length;",
    "console.log(deadline + '|' + recommend);",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  expect(proc.stdout.trim()).toBe("1|2");
});

it("sortable headers are keyboard-operable and expose sort state (aria-sort)", () => {
  const html =
    readFileSync(join(site, "index.html"), "utf8") +
    "\n" +
    readFileSync(join(site, "app.js"), "utf8");
  // 静的検証: ソート可能 4 ヘッダーに tabindex / aria-sort / data-sort がある
  const ths = [...html.matchAll(/<th([^>]*data-sort="([^"]+)"[^>]*)>/g)];
  expect(ths.length).toBe(4);
  for (const m of ths) {
    expect(m[1]).toContain('tabindex="0"');
    expect(m[1]).toContain("aria-sort=");
  }
  // 既定の並び（残り昇順）に合わせて rem のみ ascending、他は none
  const attrs = Object.fromEntries(ths.map((m) => [m[2], /aria-sort="([^"]+)"/.exec(m[1])?.[1]]));
  expect(attrs).toEqual({ rem: "ascending", date: "none", conf: "none", rank: "none" });
  // 実行検証: setSortAria を抽出して fake DOM で状態遷移を確認する
  const src = jsFunction(html, "setSortAria");
  const script = [
    "const ths = ['rem','date','conf','rank'].map(k => ({ k, attrs: {} }));",
    "const document = {",
    "  querySelectorAll: () => ths.map(t => ({",
    "    getAttribute: (a) => a === 'data-sort' ? t.k : null,",
    "    setAttribute: (a, v) => { t.attrs[a] = v; },",
    "  })),",
    "};",
    `const setSortAria = ${src};`,
    "let sortAsc = true;",
    "setSortAria('rem');",
    "const s1 = JSON.stringify(ths.map(t => t.attrs['aria-sort']));",
    "setSortAria('date');",
    "const s2 = JSON.stringify(ths.map(t => t.attrs['aria-sort']));",
    "sortAsc = false;",
    "setSortAria('date');",
    "const s3 = JSON.stringify(ths.map(t => t.attrs['aria-sort']));",
    "console.log(s1 + '|' + s2 + '|' + s3);",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  const [r1, r2, r3] = proc.stdout.trim().split("|");
  expect(JSON.parse(r1)).toEqual(["ascending", "none", "none", "none"]);
  expect(JSON.parse(r2)).toEqual(["none", "ascending", "none", "none"]);
  expect(JSON.parse(r3)).toEqual(["none", "descending", "none", "none"]);
});

it("dark theme via prefers-color-scheme overrides the palette (SPEC §7)", () => {
  const html =
    readFileSync(join(site, "index.html"), "utf8") +
    "\n" +
    readFileSync(join(site, "app.js"), "utf8");
  const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
  expect(style).toContain("color-scheme: light dark");
  const root = style.match(/:root\s*\{([^}]*)\}/)?.[1] ?? "";
  const dark =
    style.match(
      /@media\s*\(prefers-color-scheme:\s*dark\)\s*\{[^{}]*:root\s*\{([^}]*)\}\s*\}/,
    )?.[1] ?? "";
  expect(dark, "@media (prefers-color-scheme: dark) が存在しない").not.toBe("");
  const varsOf = (block: string) =>
    Object.fromEntries(
      [...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]),
    );
  const light = varsOf(root);
  const darkVars = varsOf(dark);
  const lum = (hex: string) => {
    const m = /^#([0-9a-f]{6})$/i.exec(hex);
    if (!m) throw new Error(`hex でない: ${hex}`);
    const n = parseInt(m[1], 16);
    return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  };
  // ダーク値はライト値と異なり、背景が暗く・文字が明るく上書きされている
  expect(darkVars["--bg"]).not.toBe(light["--bg"]);
  expect(darkVars["--fg"]).not.toBe(light["--fg"]);
  expect(lum(darkVars["--bg"])).toBeLessThan(lum(light["--bg"]));
  expect(lum(darkVars["--fg"])).toBeGreaterThan(lum(light["--fg"]));
  expect(lum(darkVars["--bg"])).toBeLessThan(lum(darkVars["--fg"]));
});

it("drawer closes only on ✕ / backdrop click, not on inner elements", () => {
  const html =
    readFileSync(join(site, "index.html"), "utf8") +
    "\n" +
    readFileSync(join(site, "app.js"), "utf8");
  // 静的検証: BUTTON 判定の除去と名前付き関数化がビルド成果に反映されている
  expect(html).toContain("function closeDrawer(e)");
  expect(html).not.toContain('e.target.tagName === "BUTTON"');
  const src = jsFunction(html, "closeDrawer");
  // 実行検証: fake DOM で閉じる / 閉じないの 4 経路を確認する
  const script = [
    "const removals = [];",
    // #218: closeDrawer は window._prevFocus を参照するため注入する（フォーカス復元対象は無し）
    "const window = { _prevFocus: null };",
    "const backdrop = { classList: { remove: () => removals.push(1) } };",
    "const document = { getElementById: (id) => (id === 'drawerBackdrop' ? backdrop : null) };",
    "function $(id) { return document.getElementById(id); }",
    `const closeDrawer = ${src};`,
    // 1. ✕ の自前 onclick 経路（引数なし）→ 閉じる
    "closeDrawer();",
    "const r1 = removals.length;",
    // 2. バックドロップの直接クリック → 閉じる
    "closeDrawer({ target: backdrop });",
    "const r2 = removals.length;",
    // 3. ドロワー内の button → 閉じない（#207 回帰）
    "closeDrawer({ target: { tagName: 'BUTTON' } });",
    "const r3 = removals.length;",
    // 4. ドロワー内の通常クリック → 閉じない
    "closeDrawer({ target: { tagName: 'DIV' } });",
    "const r4 = removals.length;",
    "console.log(r1 + '|' + r2 + '|' + r3 + '|' + r4);",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  expect(proc.stdout.trim()).toBe("1|2|2|2");
});

it("narrow screens fall back to card layout (SPEC §7)", () => {
  const html =
    readFileSync(join(site, "index.html"), "utf8") +
    "\n" +
    readFileSync(join(site, "app.js"), "utf8");
  // 狭幅向けメディアクエリが存在し、ブレークポイントが 640px 以下
  const mq = html.match(/@media \(max-width: (\d+)px\) \{/);
  expect(mq, "@media (max-width: ...) が存在しない").not.toBeNull();
  expect(Number(mq![1])).toBeLessThanOrEqual(640);
  // カード化の要: ヘッダ行非表示・行のブロック化・既存 data-label による列名表示
  expect(html).toContain("thead { display: none; }");
  expect(html).toContain("attr(data-label)");
  // 残り時間セルにも data-label が付き、カード内で列名が表示される
  expect(html).toContain('td(tr, "残り", "c-deadline")');
});

it("deadline display includes AoE notation (SPEC §7)", () => {
  const html =
    readFileSync(join(site, "index.html"), "utf8") +
    "\n" +
    readFileSync(join(site, "app.js"), "utf8");
  // 静的検証: 表の日時セルとドロワーの両方に AoE 併記がある
  expect(html).toContain('line(c1, fmtAoE(d), "sub nowrap")');
  expect(html).toContain("fmtAoE(new Date(r.t))");
  // 実行検証: fmtAoE は UTC-12 の壁時計を返す（例: 12:00 UTC → 00:00 AoE）
  const src = jsFunction(html, "fmtAoE");
  const script = [
    "function pad(n) { return (n < 10 ? '0' : '') + n; }",
    `const fmtAoE = ${src};`,
    "const d = new Date(Date.UTC(2026, 8, 1, 12, 0));",
    "const e = new Date(Date.UTC(2026, 8, 2, 0, 30));",
    "console.log(fmtAoE(d) + '|' + fmtAoE(e));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  expect(proc.stdout.trim()).toBe("2026-09-01 00:00 AoE|2026-09-01 12:30 AoE");
});

it("past-deadline toggle reveals past rows (SPEC §7)", () => {
  const html =
    readFileSync(join(site, "index.html"), "utf8") +
    "\n" +
    readFileSync(join(site, "app.js"), "utf8");
  // 静的検証: トグル UI と URL 状態の配線がある
  expect(html).toContain('id="past"');
  expect(html).toContain('state.past = p.get("past") === "1"');
  expect(html).toContain('if (state.past) p.set("past", "1");');
  // 実行検証: past=false では過去行が出ず、past=true で出る
  const filterSrc = jsFunction(html, "filter");
  const script = [
    "const DAY = 86400000;",
    `const FILTER = ${JSON.stringify(filterSrc)};`,
    'const now = Date.parse("2026-08-10T00:00:00Z");',
    "class FakeDate extends Date { static now() { return now; } }",
    "function row(tOff) {",
    "  return {",
    "    kind: 'paper', est: false, cats: ['hpc'], rankPairs: [], hay: 'x',",
    "    t: now + tOff, tLast: now + tOff, ed: { deadlines: [] }",
    "  };",
    "}",
    // 未来の paper と過去の paper
    "const rows = [row(86400000), row(-86400000)];",
    "const mk = (past) => new Function('Date', 'DAY', 'rows', 'state', 'sortAsc', 'sortKey',",
    "  'return (' + FILTER + ')')(FakeDate, DAY, rows,",
    "  { q: '', cats: [], kind: '', rank: '', win: 'all', est: false, past: past }, true, 'rem');",
    "console.log(JSON.stringify(mk(false)().length) + '|' + JSON.stringify(mk(true)().length));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  expect(proc.stdout.trim()).toBe("1|2");
});

it("drawer is a keyboard-operable modal dialog with focus management (#218)", () => {
  const html =
    readFileSync(join(site, "index.html"), "utf8") +
    "\n" +
    readFileSync(join(site, "app.js"), "utf8");
  // 静的検証: dialog セマンティクス・無名アイコンボタンのラベル・キーボード経路・ヒント表記
  expect(html).toContain('role="dialog" aria-modal="true" aria-labelledby="drawerTitle"');
  expect(html).toContain('aria-label="閉じる"');
  expect(html).toContain("tr.tabIndex = -1;");
  expect(html).toContain("<kbd>d</kbd> 詳細");
  // 実行検証: d キーで選択行のドロワーが開き、開閉でフォーカスが移る / 戻る
  const keySrc = jsFunction(html, "onKeydown");
  const openSrc = jsFunction(html, "openDrawer");
  const closeSrc = jsFunction(html, "closeDrawer");
  const script = [
    "const calls = { open: [], focus: [] };",
    "const prevEl = { focus() { calls.focus.push('prev'); document.activeElement = prevEl; } };",
    "const closeBtn = { focus() { calls.focus.push('close'); document.activeElement = closeBtn; } };",
    "const rowEls = [",
    "  { focus() { calls.focus.push('row0'); document.activeElement = rowEls[0]; } },",
    "  { focus() { calls.focus.push('row1'); document.activeElement = rowEls[1]; } },",
    "];",
    "rowEls[0].classList = { contains: () => false };",
    "rowEls[1].classList = { contains: () => false };",
    "const backdrop = { classList: { add() {}, remove() {} } };",
    "const els = {",
    "  drawerBackdrop: backdrop, drawerTitle: {}, drawerFullName: {}, drawerBody: {},",
    "  drawerClose: closeBtn, tbody: { querySelectorAll: () => rowEls }, q: { focus() {} },",
    "};",
    "const document = { activeElement: prevEl, getElementById: (id) => els[id] || null };",
    "function $(id) { return document.getElementById(id); }",
    "const window = { _prevFocus: null };",
    "const openSpy = (r) => calls.open.push(r);",
    "const closeSpy = () => {};",
    `const KEY = ${JSON.stringify(keySrc)};`,
    `const OPEN = ${JSON.stringify(openSrc)};`,
    `const CLOSE = ${JSON.stringify(closeSrc)};`,
    "const onKeydown = new Function('window', 'document', '$', 'selectedIndex', 'shown', 'openDrawer', 'closeDrawer', 'return (' + KEY + ')')(window, document, $, 1, ['A', 'B'], openSpy, closeSpy);",
    // d キー → 選択行 (shown[1]) のドロワーが開き、行にフォーカスが移る
    "onKeydown({ key: 'd', preventDefault() {}, target: { tagName: 'BODY' } });",
    "const dOpened = calls.open.length === 1 && calls.open[0] === 'B';",
    "const dFocusedRow = calls.focus[calls.focus.length - 1] === 'row1';",
    "const openDrawer = new Function('window', 'document', '$', 'KIND_LABEL', 'titleWithYear', 'fmtDate', 'fmtJst', 'fmtAoE', 'esc', 'safeExternalUrl', 'return (' + OPEN + ')')(window, document, $, {}, (t) => t, () => '', () => '', () => '', (s) => String(s ?? ''), (s) => String(s ?? ''));",
    "document.activeElement = prevEl;",
    "openDrawer({ kind: 'journal', conf: { title: 'X' }, ed: { place: 'P', date_text: 'D' } });",
    "const focusedClose = document.activeElement === closeBtn;",
    "const savedPrev = window._prevFocus === prevEl;",
    "const closeDrawer = new Function('window', 'document', '$', 'return (' + CLOSE + ')')(window, document, $);",
    "closeDrawer();",
    "const restored = document.activeElement === prevEl;",
    "console.log(JSON.stringify({ dOpened, dFocusedRow, focusedClose, savedPrev, restored }));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  expect(JSON.parse(proc.stdout)).toEqual({
    dOpened: true,
    dFocusedRow: true,
    focusedClose: true,
    savedPrev: true,
    restored: true,
  });
});

it("global shortcuts respect editable targets and recommendation mode", () => {
  const html =
    readFileSync(join(site, "index.html"), "utf8") +
    "\n" +
    readFileSync(join(site, "app.js"), "utf8");
  const keySrc = jsFunction(html, "onKeydown");
  const script = [
    "const calls = { prevented: 0, focused: 0, opened: 0 };",
    "const state = { mode: 'recommend' };",
    "const window = {};",
    "const document = {};",
    "function $(id) { return id === 'q' ? { focus() { calls.focused++; } } : null; }",
    "const onKeydown = new Function('state', 'window', 'document', '$', 'selectedIndex', 'shown', 'openDrawer', 'closeDrawer', 'return (' + KEY + ')')(state, window, document, $, 0, [], () => { calls.opened++; }, () => {});",
    "function event(key, target) { onKeydown({ key, target, preventDefault() { calls.prevented++; } }); }",
    "event('j', { tagName: 'TEXTAREA', isContentEditable: false });",
    "event('j', { tagName: 'DIV', isContentEditable: true });",
    "event('j', { tagName: 'BODY', isContentEditable: false });",
    "event('/', { tagName: 'BODY', isContentEditable: false });",
    "console.log(JSON.stringify(calls));",
  ].join("\n");
  const proc = spawnSync("node", ["-e", `const KEY = ${JSON.stringify(keySrc)};\n${script}`], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(proc.status, proc.stderr).toBe(0);
  expect(JSON.parse(proc.stdout)).toEqual({ prevented: 2, focused: 1, opened: 0 });
});

it("meeting past rule is wired to the end date", () => {
  const html =
    readFileSync(join(site, "index.html"), "utf8") +
    "\n" +
    readFileSync(join(site, "app.js"), "utf8");
  expect(html).not.toContain('kind: "event"');
  expect(html).not.toContain('event: "開催"');
});

it("upcoming.md window honors config site.upcoming_days", async () => {
  const confs = [
    makeConference({
      key: "win60",
      title: "WIN60",
      categories: ["hpc"],
      sources: ["local"],
      editions: [
        makeEdition({
          year: 2026,
          edition_id: "win6026",
          source: "local",
          deadlines: [
            makeDeadline("paper", "paper", utc(2026, 8, 20)), // +11d: inside a 60d window
          ],
        }),
        makeEdition({
          year: 2026,
          edition_id: "win6026b",
          source: "local",
          deadlines: [
            makeDeadline("paper", "paper", utc(2026, 11, 15)), // +98d: inside 180d, outside 60d
          ],
        }),
      ],
    }),
  ];
  const outdir = mkdtempSync(join(tmpdir(), "cfp-win-"));
  await buildAll(confs, { categories: { hpc: "HPC" }, site: { upcoming_days: 60 } }, outdir, NOW, {
    noEmbeddings: true,
  });
  const text = readFileSync(join(outdir, "upcoming.md"), "utf8");
  // ヘッダは設定値を表示する
  expect(text).toContain("# 直近 60 日の締切と開催");
  // 60 日以内の締切は残り、60 日超は窓から落ちる
  expect(text).toContain("WIN60");
  expect(text).not.toContain("2026-11-15");
  // llms.txt の説明も設定値に一致する
  const llms = readFileSync(join(outdir, "llms.txt"), "utf8");
  expect(llms).toContain("直近 60 日の締切と開催の表");
});

it("toUpcomingMd formats sub-hour remaining times as minutes and sub-day as hours", () => {
  const confs = [
    makeConference({
      key: "urgent",
      title: "URGENT",
      categories: ["systems"],
      editions: [
        makeEdition({
          year: 2026,
          edition_id: "urgent26",
          deadlines: [
            makeDeadline("paper", "Paper", new Date(NOW.getTime() + 45 * 60_000)), // +45min
            makeDeadline("abstract", "Abstract", new Date(NOW.getTime() + 3 * 3_600_000)), // +3h
            makeDeadline("notification", "Notification", new Date(NOW.getTime() + 2 * 86_400_000)), // +2d
          ],
        }),
      ],
    }),
  ];
  const recs = recordsOf(confs);
  const md = toUpcomingMd(recs, NOW, 30);
  expect(md).toContain("| 45分 |");
  expect(md).toContain("| 3時間 |");
  expect(md).toContain("| 2日 |");
});

it("toUpcomingMd outputs fallback row when no upcoming deadlines match", () => {
  const md = toUpcomingMd([], NOW, 30);
  expect(md).toContain("| - | - | 該当なし | - | - | - | - |");
});

it("toLlmsTxt documents outputs and categories correctly", () => {
  const text = toLlmsTxt({
    categories: { systems: "Systems" },
  });
  expect(text).toContain("data.json");
  expect(text).toContain("upcoming.md");
  expect(text).toContain("catalog.json");
  expect(text).toContain("recommendation-index.json");
  expect(text).toContain("app.js");
  expect(text).not.toMatch(/\.ics/);
  expect(text).toContain("実在値: systems");
});

it("site template statUpcoming counts confirmed submission deadlines only", () => {
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const runtime = readFileSync(join(REPO_ROOT, "site", "app.js"), "utf8");
  expect(template).toMatch(/Content-Security-Policy/);
  expect(template).toMatch(
    /script-src 'self' 'unsafe-inline' https:\/\/cdn\.jsdelivr\.net https:\/\/cdnjs\.cloudflare\.com/,
  );
  expect(template).toMatch(
    /connect-src 'self' https:\/\/cdn\.jsdelivr\.net https:\/\/huggingface\.co https:\/\/cdn-lfs\.huggingface\.co/,
  );
  expect(template).not.toMatch(/script-src[^>]*\*/);
  // statUpcoming の計算が投稿締切 (abstract/paper) かつ非推定 (!r.est) のみに限定されていること
  expect(runtime).toContain(
    'rows.filter((r) => (r.kind === "abstract" || r.kind === "paper") && !r.est',
  );
});

it("site template lazy-loads recommendation data outside the catalog shell (#468)", () => {
  const runtime = readFileSync(join(REPO_ROOT, "site", "app.js"), "utf8");
  expect(runtime).toContain('fetch("recommendation-index.json")');
  expect(runtime).toContain("setRecommendationProfile(data)");
});

it("site runtime lazy-loads deadline history with retry and stale-response guards (#491)", () => {
  const runtime = readFileSync(join(REPO_ROOT, "site", "app.js"), "utf8");
  expect(runtime).toContain("function createHistoryLoader(fetchJson, onState)");
  expect(runtime).toContain("function resolveHistoryRef()");
  expect(runtime).toContain('if (state.mode === "deadlines" && state.past) loadHistoryData();');
  expect(runtime).toContain('if (state.mode !== "deadlines" || !state.past) return;');
  expect(runtime).toContain('if (!response.ok) throw new Error("history " + response.status);');

  const loaderSrc = jsFunction(runtime, "createHistoryLoader");
  const script = [
    `const createHistoryLoader = ${loaderSrc};`,
    "const flush = () => new Promise((resolve) => setImmediate(resolve));",
    "const requests = [];",
    "const states = [];",
    "const loader = createHistoryLoader((ref) => new Promise((resolve, reject) => requests.push({ ref, resolve, reject })), (status) => states.push(status));",
    "(async () => {",
    '  const first = loader.load("data.json");',
    '  const same = loader.load("data.json");',
    "  await flush();",
    "  requests[0].resolve({ conferences: [{ editions: [] }] });",
    "  const value = await first;",
    '  const cached = await loader.load("data.json");',
    "  const retryRequests = [];",
    "  const retryStates = [];",
    "  const retryLoader = createHistoryLoader((ref) => new Promise((resolve, reject) => retryRequests.push({ ref, resolve, reject })), (status) => retryStates.push(status));",
    '  const bad = retryLoader.load("data.json");',
    "  await flush();",
    '  retryRequests[0].resolve({ conferences: "malformed" });',
    "  await bad;",
    '  const retried = retryLoader.load("data.json");',
    "  await flush();",
    "  retryRequests[1].resolve({ conferences: [] });",
    "  const recovered = await retried;",
    "  const staleRequests = [];",
    "  const staleStates = [];",
    "  const staleLoader = createHistoryLoader((ref) => new Promise((resolve, reject) => staleRequests.push({ ref, resolve, reject })), (status) => staleStates.push(status));",
    '  const stale = staleLoader.load("data.json");',
    "  await flush();",
    "  staleLoader.cancel();",
    '  const current = staleLoader.load("data.json");',
    "  await flush();",
    '  staleRequests[0].resolve({ conferences: [{ editions: [] }], marker: "old" });',
    '  staleRequests[1].resolve({ conferences: [], marker: "new" });',
    "  const staleValue = await stale;",
    "  const currentValue = await current;",
    "  console.log([value === cached, first === same, requests.length, states.join('|'), retryStates.join('|'), recovered && retryLoader.status, staleValue === null, currentValue.marker, staleStates.join('|')].join('|'));",
    "})();",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  expect(proc.stdout.trim()).toBe(
    "true|true|1|loading|ready|loading|error|loading|ready|ready|true|new|loading|loading|ready",
  );
});

it("site template localized shortcuts label and preset button active sync", () => {
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const runtime = readFileSync(join(REPO_ROOT, "site", "app.js"), "utf8");
  // SPEC §7: 日本語 UI。Shortcuts: ではなく ショートカット:
  expect(template).toContain("ショートカット: <kbd>j</kbd>/<kbd>k</kbd> 選択");
  expect(template).not.toContain("Shortcuts: <kbd>j</kbd>");
  // クイック抽出プリセットボタンが data-preset を持ち、updatePresetActive で同期されること
  expect(template).toContain('data-preset="7d"');
  expect(template).toContain('data-preset="a_star"');
  expect(template).toContain('data-preset="hpc_sys"');
  expect(template).toContain('data-preset="domestic"');
  expect(runtime).toContain("function updatePresetActive()");
});

it("site template does not include external Google Fonts per SPEC §7 (#223)", () => {
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  // SPEC §7: コア UI は外部 Web フォントを使わない
  expect(template).not.toContain("fonts.googleapis.com");
  expect(template).not.toContain("fonts.gstatic.com");
  expect(template).not.toContain("family=Inter");
  expect(template).not.toContain("family=JetBrains+Mono");
  expect(template).toContain("--font-sans: system-ui,");
  expect(template).toContain("--font-mono: ui-monospace,");
});

it("site template exposes independent recommendation and deadline render paths (#466)", () => {
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const runtime = readFileSync(join(REPO_ROOT, "site", "app.js"), "utf8");
  expect(template).toContain('id="modeRecommend"');
  expect(template).toContain('id="modeDeadlines"');
  expect(template).toContain('aria-pressed="false"');
  expect(template).toContain('id="deadlineTableWrap"');
  expect(template).toContain('id="recommendationCards"');
  expect(runtime).toContain("function setMode(mode)");
  expect(runtime).toContain("renderRecommendationCards(paperMode ? shown : [])");
  expect(template).toContain("mode-recommend .deadline-only");
  expect(template).toContain("mode-deadlines .recommend-only");
});

it("openDrawer escapes place, date_text, and official-site href (#390)", () => {
  const runtime = readFileSync(join(REPO_ROOT, "site", "app.js"), "utf8");
  const start = runtime.indexOf("function openDrawer");
  const end = runtime.indexOf("window.openDrawer", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const body = runtime.slice(start, end);
  expect(body).toContain("esc(r.ed.place");
  expect(body).toContain("esc(r.ed.date_text");
  expect(body).toContain("safeExternalUrl(r.ed.link || r.conf.link)");
  expect(body).toContain("esc(officialLink)");
});

it("openDrawer escapes KIND_LABEL fallback kind (#396)", () => {
  const runtime = readFileSync(join(REPO_ROOT, "site", "app.js"), "utf8");
  const start = runtime.indexOf("function openDrawer");
  const end = runtime.indexOf("window.openDrawer", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const body = runtime.slice(start, end);
  expect(body).toMatch(/esc\(\s*KIND_LABEL\[r\.kind\]/);
  expect(body).not.toMatch(/\+ \(KIND_LABEL\[r\.kind\] \|\| r\.kind\) \+/);
});

it("repolink URL is sanitised via safeExternalUrl (#419)", () => {
  // #419: DATA.sources[].url を a.href に代入する箇所が safeExternalUrl を
  // 経由していないと、javascript:alert(1) 等の不正スキーマがクロスサイト
  // スクリプティングの原因になる。ビルド成果が safeExternalUrl(localSrc.url)
  // を使うことを静的に検証する。
  const runtime = readFileSync(join(REPO_ROOT, "site", "app.js"), "utf8");
  expect(runtime).toContain("safeExternalUrl(localSrc.url)");
  expect(runtime).not.toMatch(/a\.href\s*=\s*localSrc\.url[^)]/);
});

it("SPEC §7 carves out recommender CDNs and the site stays on that allowlist (#370)", () => {
  const spec = readFileSync(join(REPO_ROOT, "SPEC.md"), "utf8");
  const section7 = spec.slice(spec.indexOf("## 7."), spec.indexOf("## 8."));
  expect(section7).toMatch(/cdn\.jsdelivr\.net/);
  expect(section7).toMatch(/@xenova\/transformers/);
  expect(section7).toMatch(/cdnjs\.cloudflare\.com/);
  expect(section7).toMatch(/pdf\.js/);
  expect(section7).toMatch(/recommender\.js/);
  expect(section7).toMatch(/フォールバック/);

  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const runtime = readFileSync(join(REPO_ROOT, "site", "app.js"), "utf8");
  const allowed = [
    "https://cdn.jsdelivr.net",
    "https://cdnjs.cloudflare.com",
    "https://huggingface.co",
    "https://cdn-lfs.huggingface.co",
    "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/+esm",
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js",
  ];
  const urls = [...(template + runtime).matchAll(/https:\/\/[^\s"'`]+/g)].map((m) => m[0]);
  const cdnLike = urls
    .map((u) => u.replace(/[;,]+$/, ""))
    .filter((u) => /cdn\.|jsdelivr|unpkg|cdnjs|googleapis|gstatic|esm\.sh/i.test(u));
  for (const url of cdnLike) {
    expect(allowed).toContain(url);
  }
});

it("escapeMdCell escapes pipe characters and collapses newlines (#236)", () => {
  expect(escapeMdCell("Tokyo | Online")).toBe("Tokyo \\| Online");
  expect(escapeMdCell("Line 1\nLine 2\r\nLine 3")).toBe("Line 1 Line 2 Line 3");
  expect(escapeMdCell(null)).toBe("");
  expect(escapeMdCell(undefined)).toBe("");
});

it("toUpcomingMd escapes pipe characters in title and place preserving 7-column table layout (#236)", () => {
  const records = [
    {
      type: "deadline" as const,
      categories: ["ai"],
      kind_label: "論文締切",
      estimated: false,
      conf: makeConference({
        key: "pipe-conf",
        title: "Test | Workshop",
        categories: ["ai"],
        sources: ["local"],
        link: "https://example.com",
      }),
      edition: makeEdition({
        year: 2026,
        edition_id: "pipe26",
        estimated: false,
        place: "Tokyo | Online (Hybrid)",
        link: "https://example.com",
      }),
      deadline: {
        kind: "paper" as const,
        label: "Paper",
        at_utc: new Date("2026-08-20T12:00:00Z"),
        tz_raw: "UTC",
        round: 1,
        comment: null,
      },
      all_day: false,
      start: new Date("2026-08-20T11:30:00Z"),
      end: new Date("2026-08-20T12:00:00Z"),
    },
    {
      type: "event" as const,
      categories: ["ai"],
      kind_label: "開催",
      estimated: false,
      conf: makeConference({
        key: "pipe-event",
        title: "Symposium | Special Track",
        categories: ["ai"],
        sources: ["local"],
        link: "https://example.com",
      }),
      edition: makeEdition({
        year: 2026,
        edition_id: "pipeev26",
        estimated: false,
        event_start: new Date("2026-08-25T00:00:00Z"),
        event_end: new Date("2026-08-27T00:00:00Z"),
        place: "Kyoto | In-person",
        link: "https://example.com",
      }),
      deadline: null,
      all_day: true,
      start: new Date("2026-08-25T00:00:00Z"),
      end: new Date("2026-08-27T00:00:00Z"),
    },
  ];
  const md = toUpcomingMd(records, new Date("2026-08-10T00:00:00Z"));
  expect(md).toContain("[Test \\| Workshop 2026](https://example.com)");
  expect(md).toContain("Tokyo \\| Online (Hybrid)");
  expect(md).toContain("[Symposium \\| Special Track 2026](https://example.com)");
  expect(md).toContain("Kyoto \\| In-person");

  // テーブルの各行の列区切り（エスケープされていないパイプ）が正確に 8 本（7 列）であることを検証
  const tableRows = md.split("\n").filter((l) => l.startsWith("|") && !l.includes("---"));
  for (const row of tableRows) {
    const unescapedPipes = row.split(/(?<!\\)\|/g).length - 1;
    expect(unescapedPipes).toBe(8);
  }
});

it("titleWithYear avoids duplicate short-year appending and handles missing years (#276, #294)", () => {
  expect(titleWithYear("CANOPIE-HPC 2026", 2026)).toBe("CANOPIE-HPC 2026");
  expect(titleWithYear("SC '26", 2026)).toBe("SC '26");
  expect(titleWithYear("SC ’26", 2026)).toBe("SC ’26");
  expect(titleWithYear("EuroSys ’26", 2026)).toBe("EuroSys ’26");
  expect(titleWithYear("GeoAI'26", 2026)).toBe("GeoAI'26");
  expect(titleWithYear("CAIS'26", 2026)).toBe("CAIS'26");
  expect(titleWithYear("SC26", 2026)).toBe("SC26");
  expect(titleWithYear("SIGCOMM", 2026)).toBe("SIGCOMM 2026");
  expect(titleWithYear("IPSJ", 0)).toBe("IPSJ");
  expect(titleWithYear("IPSJ", null)).toBe("IPSJ");
  expect(titleWithYear("IPSJ", undefined)).toBe("IPSJ");
  expect(titleWithYear(null, 2026)).toBe("");
  expect(titleWithYear(undefined, 2026)).toBe("");
});

it("escapeMdUrl sanitizes pipes, spaces, newlines, and parentheses (#284)", () => {
  expect(escapeMdUrl("https://example.com/test?a=1|b=2")).toBe(
    "https://example.com/test?a=1%7Cb=2",
  );
  expect(escapeMdUrl("https://example.com/path (2026)/cfp.html")).toBe(
    "https://example.com/path%20%282026%29/cfp.html",
  );
  expect(escapeMdUrl("https://example.com/cfp with space/")).toBe(
    "https://example.com/cfp%20with%20space/",
  );
  expect(escapeMdUrl("https://example.com/path\r\n/cfp.html")).toBe(
    "https://example.com/path/cfp.html",
  );
  expect(escapeMdUrl("https://example.com/normal")).toBe("https://example.com/normal");
  expect(escapeMdUrl("")).toBe("");
  expect(escapeMdUrl(null)).toBe("");
  expect(escapeMdUrl(undefined)).toBe("");
});

it("toUpcomingMd escapes pipe characters in URLs and preserves 7 table columns (#284)", () => {
  const records = [
    {
      type: "deadline" as const,
      categories: ["networking"],
      kind_label: "論文締切",
      estimated: false,
      conf: makeConference({
        key: "test-pipe-url",
        title: "PipeUrlConf",
        full_name: "Conference with Pipe in URL",
        categories: ["networking"],
        link: "https://example.com/cfp?track=main|poster",
      }),
      edition: makeEdition({
        year: 2026,
        edition_id: "pipe-url-2026",
        link: "https://example.com/cfp?track=main|poster",
        place: "Tokyo, Japan",
        date_text: "August 17-21, 2026",
        event_start: new Date("2026-08-17T00:00:00Z"),
        event_end: new Date("2026-08-21T00:00:00Z"),
      }),
      deadline: {
        kind: "paper" as const,
        label: "Full Paper",
        at_utc: new Date("2026-08-20T23:59:59Z"),
        tz_raw: "AoE",
        round: 1,
        comment: null,
      },
      all_day: false,
      start: new Date("2026-08-20T23:29:59Z"),
      end: new Date("2026-08-20T23:59:59Z"),
    },
  ];
  const md = toUpcomingMd(records, new Date("2026-08-10T00:00:00Z"));
  expect(md).toContain("[PipeUrlConf 2026](https://example.com/cfp?track=main%7Cposter)");

  const tableRows = md.split("\n").filter((l) => l.startsWith("|") && !l.includes("---"));
  for (const row of tableRows) {
    const unescapedPipes = row.split(/(?<!\\)\|/g).length - 1;
    expect(unescapedPipes).toBe(8); // 8 pipes = 7 columns
  }
});

it("parseCliArgs parses short flags with equals syntax (-o=dist, -c=config.yaml, etc.) (#286)", () => {
  const res1 = parseCliArgs([
    "build",
    "-o=dist",
    "-c=custom.yaml",
    "-n=2026-08-09T00:00:00Z",
    "--offline=true",
  ]);
  expect(res1.command).toBe("build");
  expect(res1.out).toBe("dist");
  expect(res1.config).toBe("custom.yaml");
  expect(res1.now).toBe("2026-08-09T00:00:00Z");
  expect(res1.offline).toBe(true);

  const res2 = parseCliArgs(["review", "-l=25", "-C=custom_cand.yaml"]);
  expect(res2.command).toBe("review");
  expect(res2.limit).toBe(25);
  expect(res2.candidates).toBe("custom_cand.yaml");

  const res3 = parseCliArgs(["discover", "-y=2027", "-d=true", "-a=true"]);
  expect(res3.command).toBe("discover");
  expect(res3.minYear).toBe(2027);
  expect(res3.dryRun).toBe(true);
  expect(res3.append).toBe(true);
});

it("buildAll falls back to site/recommender.js when custom template is in separate directory (#306)", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "cfp-custom-tmpl-"));
  const customTmpl = join(tmpDir, "custom_template.html");
  writeFileSync(customTmpl, "<html><body>/*__DATA__*/null</body></html>", "utf8");

  const outDir = join(tmpDir, "out");
  const stats = await buildAll(
    [],
    { template: customTmpl },
    outDir,
    new Date("2026-08-09T00:00:00Z"),
    {
      noEmbeddings: true,
    },
  );

  expect(stats.conferences).toBe(0);
  expect(existsSync(join(outDir, "index.html"))).toBe(true);
  expect(existsSync(join(outDir, "recommender.js"))).toBe(true);
  expect(readFileSync(join(outDir, "recommender.js"), "utf8")).toContain("Recommender");
});

it("buildAll handles null and undefined arguments safely and setRoot works (#336)", async () => {
  const originalRoot = ROOT;
  try {
    setRoot("/custom/test/root");
    expect(ROOT).toBe("/custom/test/root");
  } finally {
    setRoot(originalRoot);
  }

  const tmpDir = mkdtempSync(join(tmpdir(), "cfp-null-build-"));
  const stats = await buildAll(null, null, tmpDir, new Date("2026-08-09T00:00:00Z"), {
    noEmbeddings: true,
  });

  expect(stats.conferences).toBe(0);
  expect(stats.editions).toBe(0);
  expect(stats.deadlines).toBe(0);
  expect(existsSync(join(tmpDir, "data.json"))).toBe(true);
  expect(existsSync(join(tmpDir, "data.csv"))).toBe(true);
  expect(readdirSync(tmpDir).some((name) => name.endsWith(".ics"))).toBe(false);
});

it("parseCliArgs and cliMain handle null/undefined and auto-detect argv offset (#340)", async () => {
  expect(parseCliArgs(null)).toEqual({});
  expect(parseCliArgs(undefined)).toEqual({});

  const directHelp = await cliMain(["help"]);
  expect(directHelp).toBe(0);

  const directFlag = await cliMain(["--help"]);
  expect(directFlag).toBe(0);

  const nodeHelp = await cliMain(["node", "src/cli.ts", "help"]);
  expect(nodeHelp).toBe(0);

  const nullCode = await cliMain(null);
  expect(nullCode).toBe(2);
});

it("buildAll, toJson, and toUpcomingMd handle null/undefined now and invalid upcoming_days safely (#354)", async () => {
  const jsonNull = toJson([], {}, null);
  expect(typeof jsonNull.generated_at).toBe("string");

  const mdNull = toUpcomingMd([], null);
  expect(mdNull).toContain("該当なし");

  const mdCustomNegative = toUpcomingMd([], null, -10 as any);
  expect(mdCustomNegative).toContain("直近 180 日の締切と開催");

  const tmpDir = mkdtempSync(join(tmpdir(), "build-now-test-"));
  try {
    const stats = await buildAll([], { site: { upcoming_days: -50 } }, tmpDir, null, {
      noEmbeddings: true,
    });
    expect(stats.conferences).toBe(0);
    expect(stats.deadlines).toBe(0);
    expect(existsSync(join(tmpDir, "data.json"))).toBe(true);
    expect(existsSync(join(tmpDir, "upcoming.md"))).toBe(true);
    const md = readFileSync(join(tmpDir, "upcoming.md"), "utf8");
    expect(md).toContain("直近 180 日の締切と開催");
  } finally {
    // cleanup
  }
});

it("profileTexts and embeddingsMain handle non-array tags/categories and argv offset safely (#358)", async () => {
  const res = profileTexts([
    {
      key: "test-conf",
      title: "TestConf",
      full_name: "International Test Conference",
      categories: "systems" as any,
      tags: "niche" as any,
    },
  ]);
  expect(res.keys).toEqual(["test-conf"]);
  expect(res.texts[0]).toContain("systems");
  expect(res.texts[0]).toContain("niche");

  const nullCode = await embeddingsMain(null);
  expect(nullCode).toBe(2);

  const helpCode = await embeddingsMain(["--help"]);
  expect(helpCode).toBe(0);

  const nodeHelp = await embeddingsMain(["node", "src/embeddings.ts", "-h"]);
  expect(nodeHelp).toBe(0);
});
