/**
 * fetch-primary.ts の抽出ロジックの最小テスト。
 * Ported from tests/test_fetch_primary.py.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractDeadline,
  extractDeadlines,
  loadYamlFile,
  pageTitleYear,
  pageYear,
  pageYearMismatch,
  parsePrimaryArgs,
  runFetchPrimary,
  toLines,
} from "../src/fetch-primary.ts";

let stderrSpy: ReturnType<typeof vi.spyOn> | null = null;

afterEach(() => {
  stderrSpy?.mockRestore();
  stderrSpy = null;
});

function spyStderr(): void {
  stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
}

describe("fetch-primary extraction", () => {
  it("easychair style", () => {
    // SETTA 2026 の実例: "Submission deadline May 10, 2026"
    expect(extractDeadline("Submission deadline May 10, 2026", 2026)).toEqual({
      kind: "paper",
      label: "Paper submission",
      date: "2026-05-10",
      round: 1,
    });
  });

  it("abstract with round and tz", () => {
    const got = extractDeadline("Abstract submission (Round 2) deadline: Aug 16, 2026 (AoE)", 2026);
    expect(got).not.toBeNull();
    expect(got?.kind).toBe("abstract");
    expect(got?.round).toBe(2);
    expect(got?.tz).toBe("AoE");
    expect(got?.date).toBe("2026-08-16");
    expect(got?.label).toBe("Round 2 Abstract submission");
  });

  it("ignore stale year", () => {
    // 2 年前の残骸 (2024) は 2026 edition に拾わない。
    expect(extractDeadline("Paper submission deadline: August 21, 2024", 2026)).toBeNull();
  });

  it("accepts a valid previous-calendar-year deadline", () => {
    expect(extractDeadline("Paper submission deadline: December 31, 2025", 2026)).toEqual({
      kind: "paper",
      label: "Paper submission",
      date: "2025-12-31",
      round: 1,
    });
  });

  it("no keyword is none", () => {
    expect(extractDeadline("Registration opens January 5, 2026", 2026)).toBeNull();
  });

  it("camera ready", () => {
    const got = extractDeadline("Camera-ready deadline: October 3, 2026 23:59 UTC", 2026);
    expect(got).not.toBeNull();
    expect(got?.kind).toBe("camera_ready");
    expect(got?.tz).toBe("UTC");
  });

  it("supplementary material and rebuttal deadlines", () => {
    const supp = extractDeadline("Supplementary material deadline: June 1, 2026", 2026);
    expect(supp).not.toBeNull();
    expect(supp?.kind).toBe("supplementary");
    expect(supp?.label).toBe("Supplementary material");
    expect(supp?.date).toBe("2026-06-01");

    const rebuttal = extractDeadline("Author response deadline: July 15, 2026", 2026);
    expect(rebuttal).not.toBeNull();
    expect(rebuttal?.kind).toBe("rebuttal_end");
    expect(rebuttal?.label).toBe("Rebuttal deadline");
    expect(rebuttal?.date).toBe("2026-07-15");
  });

  it.each([
    ["Cycle 2 Paper deadline: 15-May-2026", 2026, 2, "2026-05-15", "Round 2 Paper submission"],
    ["2nd Round Paper deadline: 15/May/2026", 2026, 2, "2026-05-15", "Round 2 Paper submission"],
    ["R2 Paper deadline: May-15-2026", 2026, 2, "2026-05-15", "Round 2 Paper submission"],
    ["Cycle 1 Abstract deadline: 01-Apr-2026", 2026, 1, "2026-04-01", "Abstract submission"],
  ])("extracts rounds and hyphen dates %j", (text, year, expRound, expDate, expLabel) => {
    const got = extractDeadline(text, year);
    expect(got).not.toBeNull();
    expect(got?.round).toBe(expRound);
    expect(got?.date).toBe(expDate);
    expect(got?.label).toBe(expLabel);
  });

  it.each([
    ["Paper submission deadline: 15 May 2026", 2026, "2026-05-15"],
    ["Submission due date: 16th August 2026 (AoE)", 2026, "2026-08-16"],
    ["Paper submission deadline: 15th of May, 2026", 2026, "2026-05-15"],
    ["Paper submission deadline: 15 of May 2026", 2026, "2026-05-15"],
    ["Abstract deadline: 1st October 2026", 2026, "2026-10-01"],
    ["Paper deadline: 2026-05-10 23:59 UTC", 2026, "2026-05-10"],
    ["Paper submission deadline: 2026/08/16", 2026, "2026-08-16"],
    ["Paper submission deadline: 15-May-2026", 2026, "2026-05-15"],
    ["Paper submission deadline: 15/May/2026", 2026, "2026-05-15"],
    ["Paper submission deadline: May-15-2026", 2026, "2026-05-15"],
    ["Paper submission deadline: 15.05.2026", 2026, "2026-05-15"],
    ["Paper submission deadline: 15/05/2026", 2026, "2026-05-15"],
    ["Paper submission deadline: 15-05-2026", 2026, "2026-05-15"],
  ])("extracts alternative date formats %j -> %s", (text, year, expectedDate) => {
    const got = extractDeadline(text, year);
    expect(got).not.toBeNull();
    expect(got?.date).toBe(expectedDate);
  });

  it.each([
    "Paper submission deadline: 31 April 2026",
    "Paper submission deadline: 2026-02-30",
    "Submission due date: February 29, 2026",
  ])("invalid calendar dates fail closed %j", (text) => {
    expect(extractDeadline(text, 2026)).toBeNull();
  });

  it("loadYamlFile warns and returns {} on unparsable YAML", () => {
    spyStderr();
    const path = join(mkdtempSync(join(tmpdir(), "cfp-fp-")), "bad.yaml");
    writeFileSync(path, "conferences:\n  whpc: [unclosed\n", "utf8");
    expect(loadYamlFile(path)).toEqual({});
    const calls: string[] = (stderrSpy?.mock.calls ?? []).map((c: unknown[]) => String(c[0]));
    expect(calls.some((s) => s.includes(`cannot parse ${path}`))).toBe(true);
  });

  it("loadYamlFile parses valid YAML without warning", () => {
    spyStderr();
    const path = join(mkdtempSync(join(tmpdir(), "cfp-fp2-")), "ok.yaml");
    writeFileSync(
      path,
      "conferences:\n  whpc:\n    editions:\n      2026:\n        deadlines:\n          - date: 2026-08-21\n",
      "utf8",
    );
    const got = loadYamlFile(path);
    expect((got.conferences as Record<string, unknown>).whpc).toBeDefined();
    const calls: string[] = (stderrSpy?.mock.calls ?? []).map((c: unknown[]) => String(c[0]));
    expect(calls.some((s) => s.includes("cannot parse"))).toBe(false);
  });

  it("to_lines splits cells", () => {
    const lines = toLines(
      "<table><tr><td>Submission deadline</td><td>Aug 16, 2026</td></tr></table>",
    );
    expect(lines).toContain("Submission deadline");
    expect(lines).toContain("Aug 16, 2026");
  });

  it("to_lines decodes decimal and hex numeric character references and entities", () => {
    const lines = toLines(
      "<p>Paper submission deadline:&#160;May&#8211;June &#x2013; August 16th, 2026 &ndash; &mdash; &apos;quoted&apos;</p>",
    );
    expect(lines[0]).toContain(
      "Paper submission deadline: May–June – August 16th, 2026 - - 'quoted'",
    );
  });

  it("extractDeadline handles entities in deadline window", () => {
    const lines = toLines("<p>Paper submission deadline:&#160;August&#160;16,&#160;2026 (AoE)</p>");
    const got = extractDeadline(lines[0], 2026);
    expect(got).not.toBeNull();
    expect(got?.date).toBe("2026-08-16");
    expect(got?.tz).toBe("AoE");
  });

  it("extract_deadlines window", () => {
    const lines = [
      "All deadlines refer to AoE.",
      "Paper submission deadline: August 21, 2026",
      "Notification: October 15, 2026",
    ];
    const got = extractDeadlines(lines, 2026);
    const kinds = new Set(got.map((g) => g.kind));
    // deadline を含まない行 (Notification) は抽出しない。kind は行自体の
    // キーワードで決まる (隣接行の notification に化けない)。
    expect(kinds).toEqual(new Set(["paper"]));
    const paper = got.find((g) => g.kind === "paper")!;
    expect(paper.tz).toBe("AoE"); // 前の行の AoE をウィンドウで拾う
  });

  it("kind hint wins over adjacent notification", () => {
    // deadline 行の次行に Notification があっても paper のまま (hmem 実例)。
    const lines = ["Submission deadline: August 17, 2026", "Notification: September 4, 2026"];
    const got = extractDeadlines(lines, 2026);
    expect(got.length).toBe(1);
    expect(got[0].kind).toBe("paper");
    expect(got[0].date).toBe("2026-08-17");
  });

  it("extracts Japanese primary deadlines correctly", () => {
    const lines = [
      "重要日程",
      "論文投稿締切: 2026年5月10日 (JST)",
      "採否通知: 2026年6月20日",
      "最終原稿締切: 2026年7月15日",
    ];
    const got = extractDeadlines(lines, 2026);
    expect(got).toEqual([
      {
        kind: "paper",
        label: "Paper submission",
        date: "2026-05-10",
        round: 1,
        tz: "JST",
      },
      {
        kind: "notification",
        label: "Notification",
        date: "2026-06-20",
        round: 1,
        tz: "JST",
      },
      {
        kind: "camera_ready",
        label: "Camera-ready submission",
        date: "2026-07-15",
        round: 1,
      },
    ]);
  });
});

describe("pageYear", () => {
  it("matches the registry year from the title", () => {
    expect(pageYear("<title>SETTA 2026: International Symposium on ...</title>", 2026)).toBe(2026);
    // レジストリが 2027 なのに title が古い版のまま → default が勝つ
    expect(pageYear("<title>SETTA 2025 (archived)</title>", 2026)).toBe(2026);
    // title に年が無い
    expect(pageYear("<title>Call for Papers</title>", 2026)).toBe(2026);
    // 未来版の誤検出防止
    expect(pageYear("<title>SETTA 2030</title>", 2026)).toBe(2026);
  });
});

describe("page-year diagnostics", () => {
  it.each([
    ["matching", "<title>SETTA 2026</title>", 2026, null],
    ["archived", "<title>SETTA 2025 (archived)</title>", 2026, 2025],
    ["future", "<title>SETTA 2030</title>", 2026, 2030],
    ["missing", "<title>Call for Papers</title>", 2026, null],
  ])(
    "detects %s title years without changing the safe fallback",
    (_name, html, registryYear, mismatch) => {
      expect(pageYearMismatch(html, registryYear)).toBe(mismatch);
      expect(pageYear(html, registryYear)).toBe(registryYear);
    },
  );

  it("exposes only an unambiguous title year", () => {
    expect(pageTitleYear("<title>SETTA 2026</title>")).toBe(2026);
    expect(pageTitleYear("<title>ICDCS 2026 - 46th IEEE ICDCS 2026</title>")).toBe(2026);
    expect(pageTitleYear("<title>ACM SIGCOMM 2026 (SIGCOMM 2026) Conference 2026</title>")).toBe(
      2026,
    );
    expect(pageTitleYear("<title>SETTA 2025 / 2026</title>")).toBeNull();
    expect(pageTitleYear("<title>Annual Symposium on Systems</title>")).toBeNull();
    expect(pageYearMismatch("<title>ICDCS 2026 - 46th IEEE ICDCS 2026</title>", 2025)).toBe(2026);
    expect(pageYearMismatch("<title>ICDCS 2026 - 46th IEEE ICDCS 2026</title>", 2026)).toBeNull();
  });
});

describe("runFetchPrimary", () => {
  it("returns 2 when registry has no conferences", async () => {
    spyStderr();
    const emptyRegistry = join(mkdtempSync(join(tmpdir(), "cfp-reg-")), "empty.yaml");
    writeFileSync(emptyRegistry, "conferences: {}\n", "utf8");
    const code = await runFetchPrimary(false, emptyRegistry);
    expect(code).toBe(2);
  });
});

describe("parsePrimaryArgs and null safety", () => {
  it("handles short flags -a, -r, -o, -h and -- flags", () => {
    const res = parsePrimaryArgs([
      "-a",
      "-r",
      "/tmp/custom-reg.yaml",
      "-o",
      "/tmp/custom-out.yaml",
    ]);
    expect(res.apply).toBe(true);
    expect(res.registryPath).toBe("/tmp/custom-reg.yaml");
    expect(res.outPath).toBe("/tmp/custom-out.yaml");
    expect(res.help).toBe(false);

    const helpRes = parsePrimaryArgs(["-h"]);
    expect(helpRes.help).toBe(true);
  });

  it("toLines, extractDeadline, and pageTitleYear handle null/undefined defensively", () => {
    expect(toLines(null)).toEqual([]);
    expect(toLines(undefined)).toEqual([]);
    expect(toLines("")).toEqual([]);

    expect(extractDeadline(null, 2026)).toBeNull();
    expect(extractDeadline(undefined, 2026)).toBeNull();
    expect(extractDeadline("", 2026)).toBeNull();

    expect(pageTitleYear(null)).toBeNull();
    expect(pageTitleYear(undefined)).toBeNull();
    expect(pageTitleYear("")).toBeNull();
  });
});
