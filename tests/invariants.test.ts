import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./helpers.js";

// 教訓 66 (I3): overrides.yaml の 2027 以降 edition で
// 「event 情報のみ・deadlines 無し」のブロックは、意図マーカー
// （未公開 / CFP 未 / 会期のみ / 上流と一致 等のコメント）を必須とする。
// 経緯: esann 2027 (教訓 65) — 会期だけの実 edition 追加が merge の
// 「実 edition は推定を置換」ルールで推定締切を消し、締切 0 件になった。
const OVERRIDES_PATH = join(REPO_ROOT, "data", "overrides.yaml");

// 意図マーカーとして認める語（コメント内に現れればよい）
const MARKERS =
  /未公開|CFP\s*未|会期のみ|上流と一致|意図的|\bTBA\b|\bintentional|deadlines?\s*(なし|無し|未|空)/i;

interface EventOnlyBlock {
  key: string;
  year: number;
}

/**
 * overrides.yaml の生テキストを走査し、2027+ の edition で
 * `deadlines:` キーを持たないブロックを列挙する。
 * 各ブロックの直上コメントに意図マーカーが無ければ FAIL。
 */
function findUnmarkedEventOnlyBlocks(raw: string, minYear = 2027): EventOnlyBlock[] {
  const lines = raw.split("\n");
  const hits: EventOnlyBlock[] = [];
  // ブロック構造: `<key>:` → `    editions:` → `      <year>:` (conferences 直下)
  for (let i = 0; i < lines.length; i++) {
    const m = /^ {2}([a-z0-9-]+):\s*$/.exec(lines[i]); // conferences.<key>:
    if (!m) continue;
    const key = m[1];
    if (key === "aliases" || key === "drop") continue;
    // editions を探す
    let j = i + 1;
    while (j < lines.length && /^\s/.test(lines[j]) && !/^ {2}[a-z0-9-]+:/.test(lines[j])) {
      if (/^ {4}editions:/.test(lines[j])) break;
      j++;
    }
    if (j >= lines.length || !/^ {4}editions:/.test(lines[j])) continue;
    // editions 配下の year ブロック
    let k = j + 1;
    while (k < lines.length && /^\s/.test(lines[k]) && !/^ {4}[a-z0-9-]+:/.test(lines[k])) {
      const ym = /^ {6}(\d{4}):\s*$/.exec(lines[k]);
      if (ym) {
        const year = Number(ym[1]);
        if (year >= minYear) {
          // この year ブロック内に deadlines: / event 情報があるか（次の year ブロックまで）
          let l = k + 1;
          let hasDeadlines = false;
          let hasEventInfo = false;
          while (
            l < lines.length &&
            /^\s/.test(lines[l]) &&
            !/^ {6}\d{4}:/.test(lines[l]) &&
            !/^ {4}[a-z0-9-]+:/.test(lines[l]) &&
            !/^ {2}[a-z0-9-]+:/.test(lines[l])
          ) {
            if (/deadlines:/.test(lines[l])) hasDeadlines = true;
            if (/date_text:|event_start:|event_end:|place:/.test(lines[l])) hasEventInfo = true;
            l++;
          }
          // 規律対象: event 情報のみ（date_text 等）で deadlines を持たないブロック。
          // link のみのブロックは対象外（会期・締切どちらも触れず事故経路にならない）。
          if (!hasDeadlines && hasEventInfo) {
            // コメント窓: key 行の直前コメント群まで含める
            const above = lines.slice(Math.max(0, i - 8), k).join("\n");
            if (!MARKERS.test(above)) hits.push({ key, year });
          }
        }
      }
      k++;
    }
  }
  return hits;
}

describe("invariants", () => {
  it("I3: overrides.yaml の 2027+ event-only edition は意図マーカー必須", () => {
    const raw = readFileSync(OVERRIDES_PATH, "utf8");
    const hits = findUnmarkedEventOnlyBlocks(raw);
    expect(hits).toEqual([]);
  });

  it("I3: マーカー有りの event-only ブロックは合格する", () => {
    const raw = `
conferences:
  # 会期のみ（締切は CFP 未発表）
  dummy-conf:
    editions:
      2027:
        date_text: April 1-3, 2027
        event_start: '2027-04-01'
        event_end: '2027-04-03'
`;
    expect(findUnmarkedEventOnlyBlocks(raw)).toEqual([]);
  });

  it("I3: マーカー無しの 2027+ event-only ブロックを検出する (fail-closed)", () => {
    const raw = `
conferences:
  dummy-conf:
    editions:
      2027:
        date_text: April 1-3, 2027
        event_start: '2027-04-01'
        event_end: '2027-04-03'
`;
    const hits = findUnmarkedEventOnlyBlocks(raw);
    expect(hits).toEqual([{ key: "dummy-conf", year: 2027 }]);
  });
});
