/**
 * 候補レビュー支援: レビュー優先順位 (締切昇順)・重複グループ・predatory 疑い・
 * 過去締切を一覧する。Ported from scripts/review_candidates.py.
 * 使い方: node src/review-candidates.ts [--limit 60] [--candidates data/discovered_candidates.yaml]
 * 出力はレビュー時の判断材料で、収録 (extra.yaml 昇格) は公式サイト裏取り後に人間が行う。
 */

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { load as loadYaml } from "js-yaml";
import { parseNow } from "./cli.ts";
import { parseDeadlineText } from "./discover.ts";

export let ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function setRoot(root: string): void {
  ROOT = root;
}

// 名乗りベースの危険フラグ。確定 predatory ではない (IEEE の一部も Ei 名乗り)。
const PREDATORY_HINTS = ["ei compendex", "scopus", "ieee xplore", "indexed by"];

export function isPredatory(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = String(text).toLowerCase();
  return PREDATORY_HINTS.some((h) => t.includes(h));
}

export function tagSource(tags: unknown): string {
  if (Array.isArray(tags)) {
    const last = tags[tags.length - 1];
    return last !== undefined && last !== null && String(last).trim() !== ""
      ? String(last).trim()
      : "?";
  }
  if (typeof tags === "string" && tags.trim() !== "") {
    return tags.trim();
  }
  return "?";
}

export function normTitle(title: string | null | undefined): string {
  /** 年・記号を落とした正規化タイトル (重複グループ検出用)。Unicode/日本語文字を保持。 */
  if (!title) return "";
  let t = String(title).normalize("NFKC").toLowerCase();
  t = t.replace(/['’]\d\d\b/g, ""); // '26 形式の短縮年
  t = t.replace(/\b20\d\d(?:年|\b)/g, ""); // 2026 / 2026年 形式の年
  t = t.replace(/[^\p{L}\p{N}]+/gu, " ");
  return t.trim().split(/\s+/).join(" ");
}

export function loadTrackedTitles(root: string = ROOT): Set<string> {
  /** 収録済み (snapshot.json + data/extra.yaml + data/overrides.yaml) の正規化タイトル・フルネーム・キー集合。 */
  const tracked = new Set<string>();
  const add = (c: Record<string, unknown>): void => {
    if (typeof c.title === "string" && c.title) {
      const k = normTitle(c.title);
      if (k) tracked.add(k);
    }
    if (typeof c.full_name === "string" && c.full_name) {
      const k = normTitle(c.full_name);
      if (k) tracked.add(k);
    }
    if (typeof c.key === "string" && c.key) {
      const k = normTitle(c.key);
      if (k) tracked.add(k);
    }
  };
  try {
    const snap = JSON.parse(readFileSync(join(root, "data", "snapshot.json"), "utf8")) as Record<
      string,
      any
    >;
    for (const c of (snap.conferences as unknown[] | null) ?? []) {
      if (typeof c === "object" && c !== null) add(c as Record<string, unknown>);
    }
  } catch {
    // snapshot が無い/壊れている場合も extra.yaml 側で拾う
  }
  try {
    const extra = loadYaml(readFileSync(join(root, "data", "extra.yaml"), "utf8")) as Record<
      string,
      any
    >;
    for (const c of (extra.conferences as unknown[] | null) ?? []) {
      if (typeof c === "object" && c !== null) add(c as Record<string, unknown>);
    }
  } catch {
    // extra.yaml が無い場合
  }
  try {
    const overrides = loadYaml(
      readFileSync(join(root, "data", "overrides.yaml"), "utf8"),
    ) as Record<string, any>;
    for (const [key, val] of Object.entries(
      (overrides?.conferences as Record<string, unknown>) ?? {},
    )) {
      const k = normTitle(key);
      if (k) tracked.add(k);
      if (typeof val === "object" && val !== null) add(val as Record<string, unknown>);
    }
  } catch {
    // overrides.yaml が無い場合
  }
  return tracked;
}

interface Enriched {
  c: Record<string, any>;
  dl: Date | null;
  pred: boolean;
  tracked: boolean;
}

/**
 * レビュー締切判定に使うテキスト。EasyChair 候補は edition date_text が開催日
 * のため、候補レベルの submission_deadline_text (提出締切) を優先する。
 */
export function reviewDeadlineText(c: Record<string, any> | null | undefined): string {
  if (!c || typeof c !== "object") return "";
  if (c.submission_deadline_text) return String(c.submission_deadline_text);
  const ed = (Array.isArray(c.editions) && c.editions.length > 0 ? c.editions[0] : {}) as Record<
    string,
    any
  >;
  if (ed && typeof ed === "object" && ed.date_text) return String(ed.date_text);
  if (c.date_text) return String(c.date_text);
  const dls = (
    Array.isArray(c.deadlines) && c.deadlines.length > 0
      ? c.deadlines
      : ed && Array.isArray(ed.deadlines) && ed.deadlines.length > 0
        ? ed.deadlines
        : []
  ) as Array<Record<string, any>>;
  if (dls.length > 0) {
    const raw = dls[0]?.date || dls[0]?.utc || dls[0]?.deadline;
    if (raw) return String(raw);
  }
  return "";
}

export function runReviewCandidates(
  candidatesPath: string,
  limit: number,
  today: Date | null | undefined,
  root: string = ROOT,
): void {
  const safeToday = today instanceof Date && !Number.isNaN(today.getTime()) ? today : new Date();
  const resolvedPath = isAbsolute(candidatesPath) ? candidatesPath : join(root, candidatesPath);
  let text: string;
  try {
    text = readFileSync(resolvedPath, "utf8");
  } catch (err) {
    console.warn(`warning: cannot read candidates from ${resolvedPath} (${String(err)})`);
    return;
  }
  const data = (loadYaml(text) as Record<string, any>) ?? {};
  const cands =
    (data.candidates as unknown[] | null) ?? (data.conferences as unknown[] | null) ?? [];

  const tracked = loadTrackedTitles(root);
  const enriched: Enriched[] = cands
    .filter((raw): raw is Record<string, any> => raw !== null && typeof raw === "object")
    .map((c) => {
      const tKey = normTitle(String(c.title ?? ""));
      const fKey = normTitle(String(c.full_name ?? ""));
      const kKey = normTitle(String(c.key ?? ""));
      return {
        c,
        dl: parseDeadlineText(reviewDeadlineText(c)),
        pred: isPredatory(`${c.title ?? ""} ${c.full_name ?? ""}`),
        tracked:
          (Boolean(tKey) && tracked.has(tKey)) ||
          (Boolean(fKey) && tracked.has(fKey)) ||
          (Boolean(kKey) && tracked.has(kKey)),
      };
    });

  const future = enriched
    .filter((e) => e.dl && e.dl.getTime() >= safeToday.getTime() && !e.tracked)
    .sort((a, b) => a.dl!.getTime() - b.dl!.getTime());
  const past = enriched.filter((e) => e.dl && e.dl.getTime() < safeToday.getTime() && !e.tracked);
  const unknown = enriched.filter((e) => !e.dl && !e.tracked);
  const already = enriched.filter((e) => e.tracked);

  const fmt = (d: Date): string => d.toISOString().slice(0, 10);
  console.log(`=== レビュー推奨: 締切昇順 (未来 ${future.length} 件中 上位 ${limit} 件) ===`);
  for (const e of future.slice(0, limit)) {
    const flag = e.pred ? " [predatory疑い]" : "";
    console.log(`${fmt(e.dl!)}  ${String(e.c.title).slice(0, 44)}${flag}`);
    console.log(`    ${e.c.link ?? ""}  tags=${e.c.tags ?? ""}`);
  }

  const groups = new Map<string, Enriched[]>();
  for (const e of enriched) {
    const key = normTitle(String(e.c.title ?? ""));
    if (!key) continue;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const dups = [...groups.entries()]
    .filter(([, v]) => v.length > 1)
    .sort((a, b) => b[1].length - a[1].length);
  console.log(`\n=== 重複グループ (${dups.length} 組) ===`);
  for (const [k, v] of dups.slice(0, 20)) {
    const srcs = v.map((e) => `${e.c.title}@${tagSource(e.c.tags)}`);
    console.log(`- ${k}: ${srcs.join(", ")}`);
  }

  const preds = enriched.filter((e) => e.pred);
  console.log(`\n=== predatory 疑い (${preds.length} / ${cands.length} 件) ===`);
  for (const e of preds.slice(0, 20)) {
    console.log(`- ${String(e.c.title).slice(0, 50)}`);
  }

  console.log(`\n=== 収録済みと重複 (${already.length} 件・レビュー不要) ===`);
  for (const e of already.slice(0, 15)) {
    console.log(`- ${String(e.c.title).slice(0, 50)}  (${tagSource(e.c.tags)})`);
  }

  console.log(`\n=== 過去締切のみ (${past.length} 件・レビュー不要/削除候補) ===`);
  console.log(`=== 締切不明 (${unknown.length} 件・公式サイト確認が必要) ===`);
}

export interface ReviewArgs {
  candidates: string;
  limit: number;
  now: Date;
  help?: boolean;
}

// 不正な数値（負・非整数・非数値）を既定値へフォールバック。
// --limit=-3 等は下流 future.slice(0, limit) が末尾切り捨て＋誤ヘッダ「上位 -3 件」になるのを防ぐ (#312/#302続編 と同型)。
function toPosInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && Number.isInteger(n) && n > 0 ? n : fallback;
}

export function parseArgs(argv: string[] | null | undefined): ReviewArgs {
  let candidates = join(ROOT, "data", "discovered_candidates.yaml");
  let limit = 60;
  let now = new Date();
  let help = false;

  for (let i = 0; i < (argv ?? []).length; i++) {
    const a = argv![i];
    if (a === "--help" || a === "-h" || a === "help") {
      help = true;
    } else if (a.startsWith("--candidates=") || a.startsWith("-c=") || a.startsWith("-C=")) {
      candidates = a.slice(a.indexOf("=") + 1);
    } else if ((a === "--candidates" || a === "-c" || a === "-C") && argv![i + 1]) {
      candidates = argv![++i];
    } else if (a.startsWith("--limit=") || a.startsWith("-l=")) {
      limit = toPosInt(a.slice(a.indexOf("=") + 1), 60);
    } else if ((a === "--limit" || a === "-l") && argv![i + 1]) {
      limit = toPosInt(argv![++i], 60);
    } else if (a.startsWith("--now=") || a.startsWith("-n=")) {
      now = parseNow(a.slice(a.indexOf("=") + 1));
    } else if ((a === "--now" || a === "-n") && argv![i + 1]) {
      now = parseNow(argv![++i]);
    }
  }
  return { candidates, limit, now, help };
}

function extractArgvRest(argv: string[] | null | undefined): string[] {
  if (!argv || !Array.isArray(argv)) return [];
  if (argv.length === 0) return [];
  const isNodeBin = (s: string): boolean =>
    s === "node" || s === "bun" || /(?:^|[/\\])(?:node|bun)(?:\.exe)?$/i.test(s);
  const isScript = (s: string): boolean =>
    /(?:^|[/\\])(?:cli|bench|embeddings|discover|review|fetch-primary)(?:[-_a-z0-9]*)?\.[jt]sx?$/i.test(
      s,
    );

  if (isNodeBin(argv[0])) {
    if (argv.length > 1 && (isScript(argv[1]) || !argv[1].startsWith("-"))) {
      return argv.slice(2);
    }
    return argv.slice(1);
  }
  if (isScript(argv[0])) {
    return argv.slice(1);
  }
  return argv.slice(0);
}

export async function main(argv: string[] | null | undefined): Promise<number> {
  const rest = extractArgvRest(argv);
  const args = parseArgs(rest);
  if (args.help) {
    console.log(
      "usage: node src/review-candidates.ts [--candidates <path>] [--limit <n>] [--now <iso>]",
    );
    return 0;
  }
  runReviewCandidates(args.candidates, args.limit, args.now);
  return 0;
}

const isMain = Boolean(
  process.argv[1] &&
    (process.argv[1].endsWith("review-candidates.ts") ||
      process.argv[1].endsWith("review-candidates.js")),
);
if (isMain) {
  main(process.argv).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err);
      process.exitCode = 1;
    },
  );
}
