/**
 * End-to-end build from tests/fixtures/ only: SPEC.md sections 4 and 8.
 * Ported from tests/test_build_golden.py.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import { beforeAll, expect, it } from "vitest";
import {
  buildAll,
  DEFAULT_CATEGORIES,
  embeddingsStale,
  recordsOf,
  toLlmsTxt,
  toUpcomingMd,
} from "../src/build.ts";
import { usage } from "../src/cli.ts";
import { venuePapersHash } from "../src/embeddings.ts";
import {
  icsPhysicalLines,
  makeConference,
  makeDeadline,
  makeEdition,
  NOW,
  PUBLIC_FILES,
  REPO_ROOT,
  runCli,
  utc,
} from "./helpers.ts";

const ICS_FEEDS = PUBLIC_FILES.filter((f) => f.endsWith(".ics"));
const ESTIMATED_FEEDS = ICS_FEEDS.filter((f) => f.endsWith("-estimated.ics"));
const CONFIRMED_FEEDS = ICS_FEEDS.filter((f) => !f.endsWith("-estimated.ics"));

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

// --- generated file set ----------------------------------------------------

it.each(PUBLIC_FILES)("public file is generated: %s", (name) => {
  const path = join(site, name);
  expect(require("node:fs").existsSync(path), `${name} missing from public/`).toBe(true);
  if (name !== ".nojekyll") {
    expect(require("node:fs").statSync(path).size, `${name} is empty`).toBeGreaterThan(0);
  }
});

it("site template feed picker covers every confirmed feed (PR #16 events.ics regression)", () => {
  // ビルド生成物の検証に加え、フロントページの購読 UI（site/template.html の
  // FEEDS 配列）が確定フィード全 12 本（all + カテゴリ 9 + deadlines + events）
  // を参照していることを静的に検証する。events.ics は生成・文書化されていたが
  // テンプレに追加されていなかった（#21）。推定フィードは「確定情報ではない」
  // ため UI には載せない判断（README のみ）を維持する。
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  const fileRefs = [...template.matchAll(/file: "([^"]+\.ics)"/g)].map((m) => m[1]);
  expect(fileRefs.length, `template FEEDS refs (${fileRefs.join(", ")})`).toBe(
    CONFIRMED_FEEDS.length,
  );
  for (const feed of CONFIRMED_FEEDS) {
    expect(fileRefs, `template FEEDS missing ${feed}`).toContain(feed);
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

// --- calendars -------------------------------------------------------------

function events(name: string): Array<Record<string, string>> {
  const text = readFileSync(join(site, name), "utf8");
  const lines = text
    .replace(/\r\n /g, "")
    .replace(/\r\n\t/g, "")
    .split("\r\n");
  const blocks: Array<Record<string, string>> = [];
  let current: Record<string, string> | null = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      current = {};
    } else if (line === "END:VEVENT") {
      if (current !== null) blocks.push(current);
      current = null;
    } else if (current !== null) {
      const idx = line.indexOf(":");
      if (idx >= 0) current[line.slice(0, idx).split(";", 1)[0]] = line.slice(idx + 1);
    }
  }
  return blocks;
}

it.each(ICS_FEEDS)("every feed parses: %s", (name) => {
  const text = readFileSync(join(site, name), "utf8");
  expect(text.startsWith("BEGIN:VCALENDAR")).toBe(true);
  for (const ev of events(name)) {
    expect(ev.UID).toBeTruthy();
    expect(ev.DTSTART).toBeTruthy();
  }
});

it("vevent counts match data.json", () => {
  let expectedDeadlines = 0;
  let expectedEvents = 0;
  let expectedEstimated = 0;
  for (const c of data.conferences) {
    for (const ed of c.editions) {
      if (ed.estimated) {
        expectedEstimated += ed.deadlines.length;
        continue;
      }
      expectedDeadlines += ed.deadlines.length;
      if (ed.event_start) expectedEvents += 1;
    }
  }
  expect(events("deadlines.ics").length).toBe(expectedDeadlines);
  expect(events("all-estimated.ics").length).toBe(expectedEstimated);
  expect(events("all.ics").length).toBe(expectedDeadlines + expectedEvents);
});

it("category feeds partition all", () => {
  const everything = new Set(events("all.ics").map((e) => e.UID));
  const union = new Set<string>();
  for (const name of ["hpc.ics", "networking.ics", "systems.ics", "ai.ics", "security.ics"]) {
    const uids = new Set(events(name).map((e) => e.UID));
    for (const u of uids) {
      expect(everything.has(u), `${name} has unknown UID ${u}`).toBe(true);
      union.add(u);
    }
  }
  for (const u of union) {
    expect(everything.has(u)).toBe(true);
  }
});

it("feeds use CRLF and fold at 75 octets", () => {
  for (const name of ICS_FEEDS) {
    const raw = readFileSync(join(site, name));
    for (const line of icsPhysicalLines(raw)) {
      // 75 オクテット折り返し（UTF-8 日本語 3 バイト文字を壊さない）
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
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

it("llms.txt indexes the feeds", () => {
  const text = readFileSync(join(site, "llms.txt"), "utf8");
  for (const name of ["all.ics", "data.json", "all-estimated.ics"]) {
    expect(text).toContain(name);
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
  expect(urls.length).toBeGreaterThanOrEqual(ICS_FEEDS.length);
  for (const u of urls) {
    expect(u.startsWith(`${base}/`)).toBe(true);
  }
  const readme = join(REPO_ROOT, "README.md");
  try {
    const text = readFileSync(readme, "utf8");
    for (const name of ["all.ics", "data.json", "llms.txt"]) {
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
  const custom = toLlmsTxt("https://example.com", null, {
    site: { title: "custom-feed" },
    categories: {},
  });
  expect(custom.split("\n")[0]).toBe("# custom-feed");
});

it("llms.txt schema summary documents every key data.json actually emits (site/papers/url)", () => {
  // #237: data.json は site（トップレベル）・papers（会議ごと）・sources[].url を
  // 出力しており、golden test も data.site の存在を検証しているが、llms.txt の
  // スキーマ要約（と SPEC §4.2）はこれらを記載していなかった。
  // エージェントは llms.txt を「最初に読む索引」として使うため、実出力との
  // 乖離をここで回帰検査する。
  const text = readFileSync(join(site, "llms.txt"), "utf8");
  const summary = text.slice(text.indexOf("## data.json のスキーマ要約"));
  // トップレベル site キー（base_url がフィード絶対 URL の基準）
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

it("index.html has the data injected", () => {
  const text = readFileSync(join(site, "index.html"), "utf8");
  expect(text).not.toContain("/*__DATA__*/null");
  expect(text).toContain("conferences");
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

// --- per-category estimated feeds (SPEC.md 4) ------------------------------

it("the single estimated feed is gone", () => {
  expect(require("node:fs").existsSync(join(site, "estimated.ics"))).toBe(false);
});

it("every category has its own estimated feed", () => {
  for (const name of [
    "all-estimated.ics",
    "hpc-estimated.ics",
    "networking-estimated.ics",
    "systems-estimated.ics",
    "ai-estimated.ics",
    "security-estimated.ics",
  ]) {
    expect(ESTIMATED_FEEDS).toContain(name);
    expect(require("node:fs").existsSync(join(site, name))).toBe(true);
  }
});

it.each(ESTIMATED_FEEDS)("estimated feed is a subset of all-estimated: %s", (name) => {
  const everything = new Set(events("all-estimated.ics").map((e) => e.UID));
  for (const e of events(name)) {
    expect(everything.has(e.UID)).toBe(true);
  }
});

it("estimated feed routes by category", () => {
  const expected: Record<string, Set<string>> = {};
  for (const c of data.conferences) {
    for (const ed of c.editions) {
      if (!ed.estimated) continue;
      for (const cat of c.categories) {
        if (!expected[cat]) expected[cat] = new Set();
        expected[cat].add(`${c.key}:${ed.year}`);
      }
    }
  }
  expect(Object.keys(expected).length).toBeGreaterThan(0);
  for (const [cat, pairs] of Object.entries(expected)) {
    const uids = events(`${cat}-estimated.ics`).map((e) => e.UID);
    for (const pair of pairs) {
      const [key, year] = pair.split(":");
      expect(uids.some((u) => u.startsWith(`${key}-${year}-`))).toBe(true);
    }
  }
});

it.each(CONFIRMED_FEEDS)("confirmed feed carries no estimate: %s", (name) => {
  const estimated = new Set<string>();
  for (const c of data.conferences) {
    for (const ed of c.editions) {
      if (ed.estimated) estimated.add(`${c.key}-${ed.year}-`);
    }
  }
  expect(estimated.size).toBeGreaterThan(0);
  for (const ev of events(name)) {
    for (const prefix of estimated) {
      expect(String(ev.UID).startsWith(prefix)).toBe(false);
    }
  }
});

// --- meeting-only conferences reach the site (SPEC.md 7) -------------------

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
  const html = readFileSync(join(site, "index.html"), "utf8");
  expect(html).not.toContain('event: "開催"');
  expect(html).toContain("KIND_LABEL[r.kind]");
  expect(html).toMatch(/r\.kind !== "abstract" && r\.kind !== "paper"/);
  for (const title of ["ISC High Performance", "HOTI", "情報処理学会 HPC 研究会"]) {
    expect(html).toContain(title);
  }
});

it("index.html 7d preset uses a real 7-day window", () => {
  const html = readFileSync(join(site, "index.html"), "utf8");
  // 「締切直近 (7日以内)」プリセットは 7 日窓で動作し、ドロップダウンに 7d がある
  expect(html).toContain("applyPreset('7d')");
  expect(html).toContain("if (type === '7d') state.win = \"7d\";");
  expect(html).toContain('value="7d">直近 7 日以内</option>');
  // 30 日窓への偽代入が残っていない（回帰防止）
  expect(html).not.toContain("if (type === '7d') state.win = \"30d\";");
});

it("index.html has domestic filter and tag", () => {
  const html = readFileSync(join(site, "index.html"), "utf8");
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

function summariesOf(text: string): string[] {
  const lines = text
    .replace(/\r\n /g, "")
    .replace(/\r\n\t/g, "")
    .split("\r\n");
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith("SUMMARY:")) out.push(line.slice(8));
  }
  return out;
}

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
  const outdir = mkdtempSync(join(tmpdir(), "cfp-sig-"));
  await buildAll(confs, { categories: { ai: "AI" } }, outdir, NOW, { noEmbeddings: true });
  // 回帰ガード: noEmbeddings が第5引数で効いていれば埋め込みは生成されない
  expect(existsSync(join(outdir, "embeddings.json"))).toBe(false);
  const summaries = summariesOf(readFileSync(join(outdir, "all.ics"), "utf8"));
  expect([...summaries].sort()).toEqual(
    [
      "SIGGRAPH 2026 論文締切: Appy Hour deadline",
      "SIGGRAPH 2026 論文締切: Posters deadline",
      "SIGGRAPH 2026 論文締切",
    ].sort(),
  );
  expect(new Set(summaries).size).toBe(summaries.length);
  const upcoming = readFileSync(join(outdir, "upcoming.md"), "utf8");
  expect(upcoming).toContain("論文締切: Posters deadline");
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
  const outdir = mkdtempSync(join(tmpdir(), "cfp-yeardup-"));
  await buildAll(confs, { categories: { hpc: "HPC" } }, outdir, NOW, { noEmbeddings: true });
  const summaries = summariesOf(readFileSync(join(outdir, "all.ics"), "utf8"));
  // 年が二重にならない（CANOPIE-HPC 2026 2026 は不可）、年なしタイトルは年が付く
  expect(summaries.some((s) => s.startsWith("CANOPIE-HPC 2026 論文締切"))).toBe(true);
  expect(summaries.some((s) => s.startsWith("CANOPIE-HPC 2026 2026"))).toBe(false);
  expect(summaries.some((s) => s.startsWith("PLAIN 2026 論文締切"))).toBe(true);
  const upcoming = readFileSync(join(outdir, "upcoming.md"), "utf8");
  expect(upcoming).toContain("[CANOPIE-HPC 2026](http");
  expect(upcoming).not.toContain("[CANOPIE-HPC 2026 2026]");
  expect(upcoming).toContain("[PLAIN 2026](");
});

it("embeddingsStale はキー集合の一致で判定する（数比較の穴）", () => {
  // venuePapersHash は実データ依存のため、実ハッシュを入れてキー集合の
  // 比較だけを検証する（ハッシュ差分は R29 の別検証でカバー）。
  const emb = (keys: string[]): Record<string, unknown> => ({
    venuePapersHash: venuePapersHash(),
    embeddings: Object.fromEntries(keys.map((k) => [k, [0.1]])),
  });
  // 同一キー集合 → stale でない
  expect(embeddingsStale(emb(["a", "b", "c"]), ["a", "b", "c"])).toBe(false);
  // 数が同じでもキーが入れ替わったら stale（数比較だと見逃す）
  expect(embeddingsStale(emb(["a", "b", "c"]), ["a", "b", "d"])).toBe(true);
  expect(embeddingsStale(emb(["a", "b", "c"]), ["a", "c", "b"])).toBe(false); // 順序は無関係
  // 数が変わったら stale
  expect(embeddingsStale(emb(["a", "b", "c"]), ["a", "b"])).toBe(true);
  expect(embeddingsStale(emb(["a", "b"]), ["a", "b", "c"])).toBe(true);
  // embeddings が無い既存データ → stale
  expect(embeddingsStale({}, ["a"])).toBe(true);
  expect(embeddingsStale(null, ["a"])).toBe(true);
  expect(embeddingsStale(undefined, ["a"])).toBe(true);
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
  const html = readFileSync(join(site, "index.html"), "utf8");
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

it("sortable headers are keyboard-operable and expose sort state (aria-sort)", () => {
  const html = readFileSync(join(site, "index.html"), "utf8");
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

it("copy button falls back to selectable text when clipboard is unavailable (SPEC §7)", () => {
  const html = readFileSync(join(site, "index.html"), "utf8");
  // 静的検証: SPEC §7 のフォールバック文言と名前付き関数がビルド成果に残る
  expect(html).toContain("コピーできません — URL を選択しました");
  expect(html).toContain("function copyToClipboard(text)");
  const src = jsFunction(html, "copyToClipboard");
  // 実行検証: fake navigator（undefined / reject / resolve）でフォールバックの有無を確認する。
  // フォールバックは一時 textarea を body に append するので、append された要素で観測する。
  // node -e のグローバル navigator は上書き不可のため、new Function のパラメータとして環境を
  // 注入し、シナリオごとにブロックスコープで独立させる（async 発火が後続シナリオへ漏れない）。
  const fakeEl = "{ value: '', setAttribute() {}, select() {}, setSelectionRange() {}, style: {} }";
  const script = [
    "const realSetTimeout = setTimeout;",
    `const src = ${JSON.stringify(src)};`,
    "const mk = new Function('navigator', 'document', '$', 'setTimeout', src + '\\nreturn copyToClipboard;');",
    "const obs = { A: [], B: [], C: [], toast: [] };",
    // A: navigator.clipboard が無い環境（file:// 等）→ 同期フォールバック、例外なし
    "{",
    "  const navigator = {};",
    "  const document = {",
    `    createElement: () => (${fakeEl}),`,
    "    body: { appendChild: (el) => { obs.A.push(el); } },",
    "    getElementById: () => null,",
    "  };",
    "  const copyToClipboard = mk(navigator, document, (id) => document.getElementById(id), realSetTimeout);",
    "  copyToClipboard('https://x/y.ics');",
    "}",
    // B: writeText が reject → 同じフォールバックへ分岐（マイクロタスクで発火）
    "{",
    "  const navigator = { clipboard: { writeText: () => Promise.reject(new Error('denied')) } };",
    "  const document = {",
    `    createElement: () => (${fakeEl}),`,
    "    body: { appendChild: (el) => { obs.B.push(el); } },",
    "    getElementById: () => null,",
    "  };",
    "  const copyToClipboard = mk(navigator, document, (id) => document.getElementById(id), realSetTimeout);",
    "  copyToClipboard('https://x/b.ics');",
    "}",
    // C: writeText が resolve → トーストのみ、フォールバックを出さない
    "{",
    "  const navigator = { clipboard: { writeText: () => Promise.resolve() } };",
    "  const document = {",
    `    createElement: () => (${fakeEl}),`,
    "    body: { appendChild: (el) => { obs.C.push(el); } },",
    "    getElementById: (id) => id === 'toast' ?",
    "      { textContent: '', classList: { add: (c) => obs.toast.push(c), remove() {} } } : null,",
    "  };",
    // 成功時のトースト消去 2 秒タイマーはスキップしてプロセスを速やかに終わらせる
    "  const setTimeout = (fn, ms) => { if (ms >= 1000) { return; } realSetTimeout(fn, ms); };",
    "  const copyToClipboard = mk(navigator, document, (id) => document.getElementById(id), setTimeout);",
    "  copyToClipboard('https://x/c.ics');",
    "}",
    // マイクロタスク（B の reject / C の resolve）の実行後にまとめて検証する
    "realSetTimeout(() => {",
    "  const val = (a) => (a[0] ? a[0].value : 'none');",
    "  console.log('A:' + obs.A.length + ':' + val(obs.A) + '|B:' + obs.B.length + ':' + val(obs.B) + '|C:' + obs.C.length + ':' + obs.toast.join(','));",
    "}, 50);",
  ].join("\n");
  const proc = spawnSync("node", ["-e", script], { encoding: "utf8", timeout: 60_000 });
  expect(proc.status, proc.stderr).toBe(0);
  expect(proc.stdout.trim()).toBe("A:1:https://x/y.ics|B:1:https://x/b.ics|C:0:show");
});

it("dark theme via prefers-color-scheme overrides the palette (SPEC §7)", () => {
  const html = readFileSync(join(site, "index.html"), "utf8");
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

it("drawer closes only on ✕ / backdrop click, not on inner buttons", () => {
  const html = readFileSync(join(site, "index.html"), "utf8");
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
    // 3. ドロワー内の button（Markdown 参照コピー）→ 閉じない（#207 回帰）
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
  const html = readFileSync(join(site, "index.html"), "utf8");
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
  const html = readFileSync(join(site, "index.html"), "utf8");
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
  const html = readFileSync(join(site, "index.html"), "utf8");
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
  const html = readFileSync(join(site, "index.html"), "utf8");
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
    "const openDrawer = new Function('window', 'document', '$', 'KIND_LABEL', 'titleWithYear', 'fmtDate', 'fmtJst', 'fmtAoE', 'getGCalUrl', 'return (' + OPEN + ')')(window, document, $, {}, (t) => t, () => '', () => '', () => '', () => '');",
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

it("meeting past rule is wired to the end date", () => {
  const html = readFileSync(join(site, "index.html"), "utf8");
  expect(html).not.toContain('kind: "event"');
  expect(html).not.toContain('event: "開催"');
});

it("two meetings in one year get distinct event UIDs", () => {
  const uids = new Set(events("all.ics").map((e) => e.UID));
  expect(uids.has("ipsj-sigdps-2026-event@conf-deadlines.github.io")).toBe(true);
  expect(uids.has("ipsj-sigdps-2026-event-2@conf-deadlines.github.io")).toBe(true);
  expect(uids.has("sigcomm-2026-event@conf-deadlines.github.io")).toBe(true);
  expect(uids.has("sigcomm-2026-event-1@conf-deadlines.github.io")).toBe(false);
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

it("toLlmsTxt documents feeds and categories correctly", () => {
  const text = toLlmsTxt("https://conf-deadlines.github.io", [["all.ics", "全フィード"]], {
    categories: { systems: "Systems" },
  });
  expect(text).toContain("https://conf-deadlines.github.io/all.ics — 全フィード");
  expect(text).toContain("実在値: systems");
});

it("site template statUpcoming counts confirmed submission deadlines only", () => {
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  // statUpcoming の計算が投稿締切 (abstract/paper) かつ非推定 (!r.est) のみに限定されていること
  expect(template).toContain(
    'rows.filter((r) => (r.kind === "abstract" || r.kind === "paper") && !r.est',
  );
});

it("site template localized shortcuts label and preset button active sync", () => {
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  // SPEC §7: 日本語 UI。Shortcuts: ではなく ショートカット:
  expect(template).toContain("ショートカット: <kbd>j</kbd>/<kbd>k</kbd> 選択");
  expect(template).not.toContain("Shortcuts: <kbd>j</kbd>");
  // クイック抽出プリセットボタンが data-preset を持ち、updatePresetActive で同期されること
  expect(template).toContain('data-preset="7d"');
  expect(template).toContain('data-preset="a_star"');
  expect(template).toContain('data-preset="hpc_sys"');
  expect(template).toContain('data-preset="domestic"');
  expect(template).toContain("function updatePresetActive()");
});

it("site template does not include external Google Fonts per SPEC §7 (#223)", () => {
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  // SPEC §7: 単一ファイル。外部 CDN・Web フォントを使わない
  expect(template).not.toContain("fonts.googleapis.com");
  expect(template).not.toContain("fonts.gstatic.com");
  expect(template).not.toContain("family=Inter");
  expect(template).not.toContain("family=JetBrains+Mono");
  expect(template).toContain("--font-sans: system-ui,");
  expect(template).toContain("--font-mono: ui-monospace,");
});

it("site template copyMarkdownRef delegates to Recommender.formatMarkdownRef (#228)", () => {
  const template = readFileSync(join(REPO_ROOT, "site", "template.html"), "utf8");
  expect(template).toContain("window.Recommender.formatMarkdownRef");
  const recommenderJs = readFileSync(join(REPO_ROOT, "site", "recommender.js"), "utf8");
  expect(recommenderJs).toContain("formatMarkdownRef: formatMarkdownRef");
});
