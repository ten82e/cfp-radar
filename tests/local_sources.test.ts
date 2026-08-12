/**
 * Local source data integrity: every deadline written in data/extra.yaml and
 * data/overrides.yaml must parse to a real instant with a recognized tz.
 *
 * R37 (2026-08-12) の背景: Interactive HPC (SC26) の締切が「date 8/15 + tz UTC」と
 * 入力され、公式「14th August 2026」+ ポータル 8/14 AoE に対し 1 日遅れた。
 * 変換コード自体は正しかったため、このテストは変換の意味論ではなく
 * 「ローカルデータの各エントリが無言で落ちない・未知 tz にならない」ことを
 * 検証する（parse 失敗はビルドで警告のうえ静かにスキップされるため）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";
import { parseInstant, resetWarnings, warningCounts } from "../src/model.ts";
import { REPO_ROOT } from "./helpers.ts";

interface RawDeadline {
  src: string;
  key: string;
  date: string;
  tz: string;
}

function rawDeadlines(): RawDeadline[] {
  const out: RawDeadline[] = [];

  // data/extra.yaml: conferences は配列（各エントリに key）。
  const extra = loadYaml(readFileSync(join(REPO_ROOT, "data", "extra.yaml"), "utf8")) as {
    conferences?: Array<{ key?: string; editions?: Array<{ deadlines?: unknown[] }> }>;
  };
  for (const conf of extra?.conferences ?? []) {
    for (const ed of conf.editions ?? []) {
      for (const dl of ed.deadlines ?? []) {
        const rec = dl as Record<string, unknown>;
        out.push({
          src: "extra.yaml",
          key: conf.key ?? "?",
          date: String(rec.date ?? ""),
          tz: String(rec.tz ?? rec.timezone ?? ""),
        });
      }
    }
  }

  // data/overrides.yaml: conferences はキー → { editions: { <年>: { deadlines } } }。
  const ovr = loadYaml(readFileSync(join(REPO_ROOT, "data", "overrides.yaml"), "utf8")) as {
    conferences?: Record<string, { editions?: Record<string, { deadlines?: unknown[] }> }>;
  };
  for (const [key, conf] of Object.entries(ovr?.conferences ?? {})) {
    for (const ed of Object.values(conf.editions ?? {})) {
      for (const dl of ed.deadlines ?? []) {
        const rec = dl as Record<string, unknown>;
        out.push({
          src: "overrides.yaml",
          key,
          date: String(rec.date ?? ""),
          tz: String(rec.tz ?? rec.timezone ?? ""),
        });
      }
    }
  }
  return out;
}

describe("local source data integrity", () => {
  it("every local deadline parses to an instant with a recognized tz", () => {
    resetWarnings();
    const rows = rawDeadlines();
    expect(rows.length).toBeGreaterThan(100);

    for (const row of rows) {
      const at = parseInstant(row.date, row.tz);
      expect(
        at,
        `${row.src} ${row.key}: unparsable date ${JSON.stringify(row.date)} tz=${JSON.stringify(row.tz)}`,
      ).not.toBeNull();
      expect(at!.getUTCFullYear()).toBeGreaterThanOrEqual(2015);
      expect(at!.getUTCFullYear()).toBeLessThanOrEqual(2032);
    }

    // 未知 tz は resolveTz が「unknown timezone ...; using UTC」と警告する。
    // ゼロであること = tz タイポ（AEO / utc+8 等）が混入していないこと。
    const counts = warningCounts();
    const unknownTz = Object.keys(counts).filter((k) => k.startsWith("unknown timezone"));
    expect(unknownTz).toEqual([]);
  });
});
