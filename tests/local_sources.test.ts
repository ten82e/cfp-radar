/**
 * Local source data integrity: every deadline written in data/extra.yaml and
 * data/overrides.yaml must parse to a real instant with a recognized tz.
 *
 * R37 (2026-08-12) の背景: Interactive HPC (SC26) の締切が「date 8/15 + tz UTC」と
 * 入力され、公式「14th August 2026」+ ポータル 8/14 AoE に対し 1 日遅れた。
 * 変換コード自体は正しかったため、このテストは変換の意味論ではなく
 * 「ローカルデータの各エントリが無言で落ちない・未知 tz にならない」ことを
 * 検証する（parse 失敗はビルドで警告のうえ静かにスキップされるため）。
 *
 * #382: 会期 date_text も同じ理由で検査する。#376 は締切検査だけでは緑のまま
 * JSON / upcoming から落ちた。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";
import {
  isConfirmedTimezone,
  parseDateRange,
  parseInstant,
  resetWarnings,
  warningCounts,
} from "../src/model.ts";
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
  } // data/overrides.yaml: conferences はキー → { editions: { <年>: { deadlines } } }。
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

  // data/primary_overrides.yaml: 一次ソース自動抽出の結果（overrides.yaml と同じ構造）。
  // パース失敗は cli が静かに {} を返すため（2026-08-12 whpc で実証）、ここで必ず検出する。
  const prim = loadYaml(
    readFileSync(join(REPO_ROOT, "data", "primary_overrides.yaml"), "utf8"),
  ) as {
    conferences?: Record<string, { editions?: Record<string, { deadlines?: unknown[] }> }>;
  };
  for (const [key, conf] of Object.entries(prim?.conferences ?? {})) {
    for (const ed of Object.values(conf.editions ?? {})) {
      for (const dl of ed.deadlines ?? []) {
        const rec = dl as Record<string, unknown>;
        out.push({
          src: "primary_overrides.yaml",
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
      if (row.src === "primary_overrides.yaml" && !isConfirmedTimezone(row.tz)) {
        // fetch-primary records the source verbatim; a missing zone is not UTC.
        expect(parseInstant(row.date, row.tz)).toBeNull();
        continue;
      }
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

  it("every extra.yaml date_text parses or is an explicit year-only / TBD exception (#382)", () => {
    const extra = loadYaml(readFileSync(join(REPO_ROOT, "data", "extra.yaml"), "utf8")) as {
      conferences?: Array<{
        key?: string;
        editions?: Array<{ year?: number; date_text?: string; date?: string }>;
      }>;
    };
    const allowNull = new Set(["TBD 2027", "2026年11月下旬～12月上旬（詳細未定）"]);
    const rows: Array<{ key: string; year: number; text: string }> = [];
    for (const conf of extra?.conferences ?? []) {
      for (const ed of conf.editions ?? []) {
        const text = String(ed.date_text ?? ed.date ?? "").trim();
        if (!text) continue;
        rows.push({ key: conf.key ?? "?", year: Number(ed.year) || 2026, text });
      }
    }
    expect(rows.length).toBeGreaterThan(50);
    const unexpected: string[] = [];
    for (const row of rows) {
      if (/^\d{4}$/.test(row.text) || allowNull.has(row.text)) continue;
      const [start, end] = parseDateRange(row.text, row.year);
      if (start === null || end === null) {
        unexpected.push(`${row.key}: ${JSON.stringify(row.text)}`);
      }
    }
    expect(unexpected).toEqual([]);
  });

  it("every YAML data file parses without error", () => {
    // primary_overrides.yaml のパース失敗は cli が静かに {} を返して全エントリを
    // 消す（2026-08-12 whpc で実証: _comment 内の「: 」でパースエラー→ビルドは成功）。
    // YAML 自体が壊れていると loadYaml が throw するので、ここで全ファイルを検証する。
    const files = [
      "data/extra.yaml",
      "data/overrides.yaml",
      "data/primary_overrides.yaml",
      "data/primary.yaml",
      "config.yaml",
    ];
    for (const f of files) {
      expect(
        () => loadYaml(readFileSync(join(REPO_ROOT, f), "utf8")),
        `${f} must parse`,
      ).not.toThrow();
    }
  });

  it("primary.yaml and fetch-primary.ts do not advertise the retired fetch_primary.py (#384)", () => {
    const primary = readFileSync(join(REPO_ROOT, "data", "primary.yaml"), "utf8");
    const src = readFileSync(join(REPO_ROOT, "src", "fetch-primary.ts"), "utf8");
    const generated = readFileSync(join(REPO_ROOT, "data", "primary_overrides.yaml"), "utf8");
    expect(primary, "primary.yaml must name the TS extractor").toContain("src/fetch-primary.ts");
    expect(primary).not.toContain("fetch_primary.py");
    expect(src).not.toContain('"#":');
    expect(src).toContain("const header =");
    expect(src).toContain("# 自動生成。src/fetch-primary.ts");
    expect(generated).not.toContain("fetch_primary.py");
    expect(generated).toContain("fetch-primary.ts");
  });

  it("overrides.yaml does not advertise the retired scripts/merge.py (#386)", () => {
    const header = readFileSync(join(REPO_ROOT, "data", "overrides.yaml"), "utf8")
      .split("\n")
      .slice(0, 8)
      .join("\n");
    expect(header, "overrides.yaml header must name src/merge.ts").toContain("src/merge.ts");
    expect(header).toContain("applyOverrides");
    expect(header).not.toContain("merge.py");
    expect(header).not.toContain("apply_overrides");
  });
});
