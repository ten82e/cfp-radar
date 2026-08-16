/**
 * 一次ソースから締切を一発どりする (data/primary.yaml → data/primary_overrides.yaml)。
 * Ported from scripts/fetch_primary.py. 使い方:
 *   node src/fetch-primary.ts            # dry-run（差分を表示）
 *   node src/fetch-primary.ts --apply    # primary_overrides.yaml に書き込む
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dump as dumpYaml, load as loadYaml } from "js-yaml";
import { roundOf, warn } from "./model.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = join(ROOT, "data", "primary.yaml");
const OUT = join(ROOT, "data", "primary_overrides.yaml");

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const BLOCK_RE =
  /<(?:br|\/p|\/div|\/tr|\/td|\/th|\/li|\/h[1-6]|\/section|\/article|\/table|\/ul|\/ol|\/dl)[^>]*>/gi;
const TAG_RE = /<[^>]+>/g;
const TZ_RE =
  /\b(PDT|PST|EDT|EST|CDT|CST|MDT|MST|AKDT|AKST|HST|UTC|GMT|CET|CEST|JST|AoE|PT|ET|CT|MT)\b|anywhere on (?:the )?(?:inhabited )?earth/gi;
const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};
const LABELS: Record<string, string> = {
  paper: "Paper submission",
  abstract: "Abstract submission",
  camera_ready: "Camera-ready submission",
  notification: "Notification",
  registration: "Registration",
  supplementary: "Supplementary material",
  rebuttal_end: "Rebuttal deadline",
};

// 検証不能なサイトが多いので証明書検証を迂回する (Python 版の CERT_NONE 相当)。
import { Agent } from "undici";

export async function fetchPage(url: string, timeout = 30_000): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA },
    dispatcher: new Agent({ connect: { rejectUnauthorized: false } }),
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

export function toLines(htmlText: string | null | undefined): string[] {
  if (!htmlText) return [];
  let text = String(htmlText).replace(BLOCK_RE, "\n").replace(TAG_RE, "");
  const entities: Record<string, string> = {
    "&nbsp;": " ",
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
    "&ndash;": "-",
    "&mdash;": "-",
    "&minus;": "-",
  };
  text = text.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
    const code = Number.parseInt(hex, 16);
    return Number.isFinite(code) && code > 0 ? String.fromCharCode(code) : "";
  });
  text = text.replace(/&#(\d+);/g, (_, dec) => {
    const code = Number.parseInt(dec, 10);
    return Number.isFinite(code) && code > 0 ? String.fromCharCode(code) : "";
  });
  text = text.replace(/&[a-zA-Z]+;/g, (m) => entities[m] ?? m);
  text = text.replace(/[ \t\u00a0\u2000-\u200b]+/g, " ");
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

export function isDeadlineLine(text: string | null | undefined): boolean {
  const low = String(text ?? "").toLowerCase();
  return (
    low.includes("deadline") ||
    low.includes("due date") ||
    low.includes("due") ||
    low.includes("締切") ||
    low.includes("締め切り") ||
    low.includes("期限") ||
    low.includes("期日") ||
    low.includes("採否") ||
    low.includes("通知日")
  );
}

function kindOf(window: string | null | undefined): string {
  const low = String(window ?? "").toLowerCase();
  if (
    low.includes("abstract") ||
    low.includes("概要") ||
    low.includes("アブストラクト") ||
    low.includes("題目")
  ) {
    return "abstract";
  }
  if (
    low.includes("camera") ||
    low.includes("カメラレディ") ||
    low.includes("最終原稿") ||
    low.includes("採択原稿")
  ) {
    return "camera_ready";
  }
  if (
    low.includes("notification") ||
    low.includes("採否") ||
    low.includes("査読結果") ||
    low.includes("判定通知") ||
    low.includes("通知")
  ) {
    return "notification";
  }
  if (low.includes("registration") || low.includes("参加登録") || low.includes("事前登録")) {
    return "registration";
  }
  if (
    low.includes("supplementary") ||
    low.includes("appendix") ||
    low.includes("補足資料") ||
    low.includes("付録")
  ) {
    return "supplementary";
  }
  if (
    low.includes("rebuttal") ||
    low.includes("author response") ||
    low.includes("author_response") ||
    low.includes("反論") ||
    low.includes("リバッタル")
  ) {
    return "rebuttal_end";
  }
  return "paper";
}

export interface PrimaryDeadline {
  kind: string;
  label: string;
  date: string;
  tz?: string;
  round?: number;
}

interface ExtractedDate {
  year: number;
  month: number;
  day: number;
}

export function parsePrimaryDate(window: string): ExtractedDate | null {
  const norm = window.normalize("NFKC");
  // 1. Japanese format: '2026年5月10日', '2026年05月10日'
  let m = /\b(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(norm);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { year, month, day };
    }
  }
  // 2. Month Day Year: 'May 10, 2026', 'August 16th, 2026', 'Sept. 15, 2026', 'May-10-2026'
  m =
    /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?[-/\s]+(\d{1,2})(?:st|nd|rd|th)?(?:,)?[-/\s]+(\d{4})\b/i.exec(
      norm,
    );
  if (m) {
    const month = MONTHS[m[1].toLowerCase().slice(0, 3)];
    const day = Number(m[2]);
    const year = Number(m[3]);
    return { year, month, day };
  }
  // 3. Day Month Year: '15 May 2026', '16th August 2026', '15th of May 2026', '1st October, 2026', '15-May-2026', '15/May/2026'
  m =
    /\b(\d{1,2})(?:st|nd|rd|th)?(?:[-/\s]+(?:of\s+)?|\s+of\s+)(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?(?:,)?[-/\s]+(\d{4})\b/i.exec(
      norm,
    );
  if (m) {
    const day = Number(m[1]);
    const month = MONTHS[m[2].toLowerCase().slice(0, 3)];
    const year = Number(m[3]);
    return { year, month, day };
  }
  // 4. Numeric Year Month Day: '2026-05-10', '2026/05/10', '2026.05.10'
  m = /\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/.exec(norm);
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { year, month, day };
    }
  }
  // 5. European Numeric Day Month Year: '15.05.2026', '15/05/2026', '15-05-2026'
  m = /\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\b/.exec(norm);
  if (m) {
    const day = Number(m[1]);
    const month = Number(m[2]);
    const year = Number(m[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { year, month, day };
    }
  }
  return null;
}

export function extractDeadline(
  window: string | null | undefined,
  year: number,
  kindHint = "",
): PrimaryDeadline | null {
  if (!window) return null;
  if (!isDeadlineLine(window) && !isDeadlineLine(kindHint)) return null;
  // 対象行 (kindHint) に日付が含まれている場合は隣接行の誤検出を避けるため優先
  const parsed = (kindHint ? parsePrimaryDate(kindHint) : null) || parsePrimaryDate(window);
  if (!parsed) return null;
  const { year: extractedYear, month, day } = parsed;
  if (extractedYear < year - 1 || extractedYear > year + 1) return null; // 過去版の残骸を拾わない
  const dt = new Date(Date.UTC(extractedYear, month - 1, day));
  if (dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null;
  const kind = kindOf(kindHint || window);
  const roundNo = roundOf(window, 1);
  let label = LABELS[kind];
  if (roundNo > 1) label = `Round ${roundNo} ${label}`;
  let tz: string | undefined;
  TZ_RE.lastIndex = 0;
  const tzM = TZ_RE.exec(window);
  if (tzM) {
    const raw = tzM[0];
    tz =
      raw.toLowerCase().includes("anywhere") || raw.toUpperCase() === "AOE"
        ? "AoE"
        : raw.toUpperCase();
  }
  const out: PrimaryDeadline = {
    kind,
    label,
    date: `${extractedYear}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    round: roundNo,
  };
  if (tz) out.tz = tz;
  return out;
}

export function pageTitleYear(htmlText: string | null | undefined): number | null {
  if (!htmlText) return null;
  const m = /<title[^>]*>(.*?)<\/title>/is.exec(htmlText);
  if (!m) return null;
  const title = m[1].replace(
    /&[a-zA-Z#0-9]+;/g,
    (x) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" })[x] ?? x,
  );
  const years = [...title.matchAll(/\b(20\d{2})\b/g)].map((x) => Number(x[1]));
  const uniqueYears = [...new Set(years)];
  return uniqueYears.length === 1 ? uniqueYears[0] : null;
}

export function pageYearMismatch(htmlText: string, registryYear: number): number | null {
  const titleYear = pageTitleYear(htmlText);
  return titleYear !== null && titleYear !== registryYear ? titleYear : null;
}

export function pageYear(_htmlText: string, fallback: number): number {
  return fallback;
}

export function extractDeadlines(lines: string[], year: number): PrimaryDeadline[] {
  const out: PrimaryDeadline[] = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (!isDeadlineLine(ln)) continue;
    const lo = Math.max(0, i - 1);
    const hi = Math.min(lines.length, i + 2);
    const window = lines.slice(lo, hi).join(" ");
    const entry = extractDeadline(window, year, ln);
    if (entry && !out.some((e) => JSON.stringify(e) === JSON.stringify(entry))) out.push(entry);
  }
  return out;
}

export function loadYamlFile(path: string): Record<string, any> {
  try {
    const loaded = loadYaml(readFileSync(path, "utf8"));
    return typeof loaded === "object" && loaded !== null ? (loaded as Record<string, any>) : {};
  } catch (exc) {
    // 静かに {} を返すと primary_overrides の「前回値」が失われ、前回値維持の
    // 保証（SPEC §data/primary.yaml）が無警告で機能しなくなる。cli.ts の
    // loadYamlFile と同じ形式で必ず警告する（2026-08-12 whpc の教訓）。
    warn(`cannot parse ${path}: ${String(exc)}`);
    return {};
  }
}

export async function runFetchPrimary(
  apply: boolean,
  registryPath = REGISTRY,
  outPath = OUT,
): Promise<number> {
  const registry = (loadYamlFile(registryPath).conferences as Record<string, any>) ?? {};
  const previous = (loadYamlFile(outPath).conferences as Record<string, any>) ?? {};
  if (Object.keys(registry).length === 0) {
    process.stderr.write(`error: ${registryPath} に conferences が無い\n`);
    return 2;
  }
  const today = new Date().toISOString().slice(0, 10);
  const generated: Record<string, any> = {};
  for (const [key, conf] of Object.entries(registry).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    const url = conf.url;
    const year = conf.year;
    if (!url || !year) {
      process.stderr.write(`warning: ${key} に url/year が無いのでスキップ\n`);
      continue;
    }
    let deadlines: PrimaryDeadline[] = [];
    try {
      const page = await fetchPage(url);
      const mismatch = pageYearMismatch(page, Number(year));
      if (mismatch !== null) {
        process.stderr.write(
          `warning: ${key}: title の年が ${mismatch} (registry: ${year}) — registry の year 更新を検討\n`,
        );
      }
      const pageYr = pageYear(page, Number(year));
      deadlines = extractDeadlines(toLines(page), pageYr);
      // 収録の「締切」を正すのが目的なので、提出締切 (paper/abstract) だけを書く。
      deadlines = deadlines.filter((d) => d.kind === "paper" || d.kind === "abstract");
      const hint = conf.tz;
      for (const d of deadlines) {
        if (d.tz === undefined && hint) d.tz = String(hint);
        if (d.tz === undefined) delete d.tz;
        if (d.round === 1) delete d.round;
      }
    } catch (exc) {
      process.stderr.write(
        `warning: ${key}: ${url} の取得に失敗 (${String(exc)}) — 前回値を維持\n`,
      );
      if (key in previous) generated[key] = previous[key];
      continue;
    }
    if (deadlines.length === 0) {
      process.stderr.write(`warning: ${key}: ${url} から締切を抽出できなかった — 前回値を維持\n`);
      if (key in previous) generated[key] = previous[key];
      continue;
    }
    const edition: Record<string, any> = { deadlines };
    for (const field of ["link", "place", "date_text"]) {
      if (conf[field]) edition[field] = conf[field];
    }
    const comment = `一次ソース (${url}) から自動抽出 (${today})`;
    generated[key] = {
      editions: { [String(year)]: edition },
      _comment: comment,
    };
  }
  if (Object.keys(generated).length === 0) {
    console.log("抽出できた会議が無い。primary_overrides.yaml は変更しない。");
    return 1;
  }
  const payload = {
    "#": "自動生成。scripts/fetch_primary.py が data/primary.yaml の一次ソースから抽出した。手で編集しない。抽出失敗した会議は前回値が維持される。",
    conferences: generated,
  };
  const yamlText = dumpYaml(payload, { skipInvalid: true });
  if (apply) {
    writeFileSync(outPath, yamlText, "utf8");
    console.log(`wrote ${outPath} (${Object.keys(generated).length} conferences)`);
  } else {
    console.log(`--- dry-run: ${outPath} (${Object.keys(generated).length} conferences) ---`);
    console.log(yamlText);
  }
  return 0;
}

export interface PrimaryArgs {
  apply: boolean;
  registryPath: string;
  outPath: string;
  help: boolean;
}

export function parsePrimaryArgs(argv: string[]): PrimaryArgs {
  let apply = false;
  let registryPath = REGISTRY;
  let outPath = OUT;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h" || a === "help") {
      help = true;
    } else if (a === "--apply" || a === "-a") {
      apply = true;
    } else if (a.startsWith("--registry=")) {
      registryPath = a.slice("--registry=".length);
    } else if ((a === "--registry" || a === "-r") && argv[i + 1]) {
      registryPath = argv[++i];
    } else if (a.startsWith("--out=")) {
      outPath = a.slice("--out=".length);
    } else if ((a === "--out" || a === "-o") && argv[i + 1]) {
      outPath = argv[++i];
    }
  }
  return { apply, registryPath, outPath, help };
}

const isMain = process.argv[1]?.endsWith("fetch-primary.ts");
if (isMain) {
  const args = parsePrimaryArgs(process.argv.slice(2));
  if (args.help) {
    console.log("usage: node src/fetch-primary.ts [--apply] [--registry <path>] [--out <path>]");
    process.exit(0);
  }
  runFetchPrimary(args.apply, args.registryPath, args.outPath).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err);
      process.exitCode = 1;
    },
  );
}
