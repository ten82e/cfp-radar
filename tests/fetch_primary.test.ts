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

  it.each([
    ["Paper submission deadline: 15 May 2026", 2026, "2026-05-15"],
    ["Submission due date: 16th August 2026 (AoE)", 2026, "2026-08-16"],
    ["Abstract deadline: 1st October 2026", 2026, "2026-10-01"],
    ["Paper deadline: 2026-05-10 23:59 UTC", 2026, "2026-05-10"],
    ["Paper submission deadline: 2026/08/16", 2026, "2026-08-16"],
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
    expect(pageTitleYear("<title>SETTA 2025 / 2026</title>")).toBeNull();
  });
});
