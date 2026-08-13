/**
 * ワークツリーの data ファイルと HEAD 版を「実質的な差」で比較する。
 * update.yml の「Commit snapshot」ステップが data/snapshot.json と
 * data/primary_overrides.yaml の両方について呼び、実質変更があるときだけ
 * コミットするために使う（SPEC.md §data/primary.yaml の「前回値維持」保証を
 * 成立させるため、生成物の永続化が必要）。
 *
 * 使い方:
 *   node scripts/compare-head.ts data/snapshot.json
 *   実質変更あり => 1 / なし（または読めない）=> 0 を stdout に出す。
 *
 * 「実質」の定義:
 *   - `generated_at`（snapshot の生成時刻）は無視する
 *   - `_comment`（primary_overrides の会議ごとの抽出日付・毎日変わる）は無視する
 *   - キーの並び順・YAML/JSON の形式差は正規化して無視する
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { load as loadYaml } from "js-yaml";

/** オブジェクトのキーを深さ優先でソートする（配列は順序を保つ）。 */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === "object") {
    const rec = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(rec)
        .sort()
        .map((k) => [k, sortKeys(rec[k])]),
    );
  }
  return v;
}

/** 再帰的に generated_at / _comment を除去する。 */
function stripChurn(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripChurn);
  if (v !== null && typeof v === "object") {
    const rec = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(rec)) {
      if (k === "generated_at" || k === "_comment") continue;
      out[k] = stripChurn(val);
    }
    return out;
  }
  return v;
}

/** 文字列を JSON / YAML として解釈し、正規化した文字列を返す。読めなければ null。 */
export function normalizeData(data: unknown): string | null {
  if (data === null || typeof data !== "object") return null;
  const normalized = sortKeys(stripChurn(data));
  try {
    return JSON.stringify(normalized);
  } catch {
    return null;
  }
}

/** ファイルの内容を JSON 優先・YAML フォールバックでパースする。 */
function parseFile(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    try {
      return loadYaml(text);
    } catch {
      return null;
    }
  }
}

/**
 * ワークツリーの path と HEAD 版を実質比較する。
 * 1 = 実質変更あり / 0 = 変更なし・どちらかが読めない（コミットしない）。
 */
export function compareToHead(path: string): 0 | 1 {
  let next: unknown = null;
  try {
    next = parseFile(readFileSync(path, "utf8"));
  } catch {
    next = null;
  }
  let prev: unknown = null;
  try {
    prev = parseFile(execFileSync("git", ["show", `HEAD:${path}`], {
      encoding: "utf8",
    }));
  } catch {
    prev = null;
  }
  const prevNorm = normalizeData(prev);
  const nextNorm = normalizeData(next);
  // 読めない側は書きかけとみなしてコミットしない（従来の挙動を維持）。
  if (prevNorm === null || nextNorm === null) return 0;
  return prevNorm === nextNorm ? 0 : 1;
}

const isMain = process.argv[1]?.endsWith("compare-head.ts");
if (isMain) {
  const path = process.argv[2];
  if (!path) {
    process.stderr.write("usage: node scripts/compare-head.ts <path>\n");
    process.exitCode = 2;
  } else {
    process.stdout.write(`${compareToHead(path)}\n`);
  }
}
