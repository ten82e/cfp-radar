/**
 * scripts/compare-head.ts — update.yml が data ファイルの実質差分検出に使う
 * ヘルパーのユニットテスト。generated_at / _comment（日々変わる抽出日付）を
 * 無視して、実質変更のときだけ 1 を返すことを保証する。
 */

import { describe, expect, it } from "vitest";
import { compareToHead, normalizeData } from "../scripts/compare-head.ts";

describe("normalizeData", () => {
  it("drops top-level generated_at", () => {
    const a = normalizeData({ generated_at: "2026-08-13T00:00:00Z", conferences: [] });
    const b = normalizeData({ generated_at: "2026-08-12T00:00:00Z", conferences: [] });
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it("drops _comment recursively (per-conference extraction dates)", () => {
    const a = normalizeData({
      conferences: {
        whpc: {
          _comment: "… (2026-08-10)",
          editions: { 2026: { deadlines: [{ date: "2026-08-21" }] } },
        },
      },
    });
    const b = normalizeData({
      conferences: {
        whpc: {
          _comment: "… (2026-08-13)",
          editions: { 2026: { deadlines: [{ date: "2026-08-21" }] } },
        },
      },
    });
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it("detects substantive deadline changes", () => {
    const a = normalizeData({
      conferences: { whpc: { editions: { 2026: { deadlines: [{ date: "2026-08-21" }] } } } },
    });
    const b = normalizeData({
      conferences: { whpc: { editions: { 2026: { deadlines: [{ date: "2026-08-28" }] } } } },
    });
    expect(a).not.toBe(b);
  });

  it("normalizes key order (YAML vs JSON equivalence)", () => {
    const a = normalizeData({ b: 1, a: { d: 2, c: 3 } });
    const b = normalizeData({ a: { c: 3, d: 2 }, b: 1 });
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it("returns null for primitives", () => {
    expect(normalizeData(null)).toBeNull();
    expect(normalizeData(42)).toBeNull();
    expect(normalizeData("text")).toBeNull();
  });
});

describe("compareToHead", () => {
  it("returns 0 when the working tree matches HEAD", () => {
    // data/snapshot.json は HEAD と同一（このテストが変更を加えていない前提）。
    expect(compareToHead("data/snapshot.json")).toBe(0);
  });

  it("returns 0 for a path that does not parse", () => {
    // 存在しないファイルは「コミットしない」側（読めない = 0）に倒す。
    expect(compareToHead("data/no-such-file.json")).toBe(0);
  });
});
