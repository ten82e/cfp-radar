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
import { warn } from "./model.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = join(ROOT, "data", "primary.yaml");
const OUT = join(ROOT, "data", "primary_overrides.yaml");

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const BLOCK_RE =
  /<(?:br|\/p|\/div|\/tr|\/td|\/th|\/li|\/h[1-6]|\/section|\/article|\/table|\/ul|\/ol|\/dl)[^>]*>/gi;
const TAG_RE = /<[^>]+>/g;
const DATE_RE =
  /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? (\d{1,2})(?:st|nd|rd|th)?(?:,)? (\d{4})\b/gi;
const TZ_RE =
  /\b(PDT|PST|EDT|EST|CDT|CST|MDT|MST|AKDT|AKST|HST|UTC|GMT|CET|CEST|JST|AoE|PT|ET|CT|MT)\b|anywhere on (?:the )?(?:inhabited )?earth/gi;
const ROUND_RE = /\bround\s*(\d+)\b/gi;
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

export function toLines(htmlText: string): string[] {
  let text = htmlText.replace(BLOCK_RE, "\n").replace(TAG_RE, "");
  const entities: Record<string, string> = {
    "&nbsp;": " ",
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
  };
  text = text.replace(/&[a-zA-Z#0-9]+;/g, (m) => entities[m] ?? m);
  text = text.replace(/[ \t\u00a0]+/g, " ");
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function kindOf(window: string): string {
  const low = window.toLowerCase();
  if (low.includes("abstract")) return "abstract";
  if (low.includes("camera")) return "camera_ready";
  if (low.includes("notification")) return "notification";
  if (low.includes("registration")) return "registration";
  return "paper";
}

export interface PrimaryDeadline {
  kind: string;
  label: string;
  date: string;
  tz?: string;
  round?: number;
}

export function extractDeadline(
  window: string,
  year: number,
  kindHint = "",
): PrimaryDeadline | null {
  const low = window.toLowerCase();
  if (!low.includes("deadline") && !low.includes("due date")) return null;
  // グローバル正規表現は lastIndex が残るので毎回リセット (Python の re.search 相当)
  DATE_RE.lastIndex = 0;
  const m = DATE_RE.exec(window);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase().slice(0, 3)];
  const day = Number(m[2]);
  const extractedYear = Number(m[3]);
  if (extractedYear !== year - 1 && extractedYear !== year) return null; // 過去版の残骸を拾わない
  const dt = new Date(Date.UTC(extractedYear, month - 1, day));
  if (dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null;
  const kind = kindOf(kindHint || window);
  ROUND_RE.lastIndex = 0;
  const roundM = ROUND_RE.exec(window);
  const roundNo = roundM ? Number(roundM[1]) : 1;
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

export function pageYear(htmlText: string, fallback: number): number {
  const m = /<title[^>]*>(.*?)<\/title>/is.exec(htmlText);
  if (!m) return fallback;
  const title = m[1].replace(
    /&[a-zA-Z#0-9]+;/g,
    (x) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" })[x] ?? x,
  );
  const years = [...title.matchAll(/\b(20\d{2})\b/g)].map((x) => Number(x[1]));
  return years.includes(fallback) ? fallback : fallback;
}

export function extractDeadlines(lines: string[], year: number): PrimaryDeadline[] {
  const out: PrimaryDeadline[] = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const low = ln.toLowerCase();
    if (!low.includes("deadline") && !low.includes("due date")) continue;
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

export async function runFetchPrimary(apply: boolean): Promise<number> {
  const registry = (loadYamlFile(REGISTRY).conferences as Record<string, any>) ?? {};
  const previous = (loadYamlFile(OUT).conferences as Record<string, any>) ?? {};
  if (Object.keys(registry).length === 0) {
    process.stderr.write(`error: ${REGISTRY} に conferences が無い\n`);
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
      const pageYr = pageYear(page, Number(year));
      if (pageYr !== Number(year)) {
        process.stderr.write(
          `warning: ${key}: title の年が ${pageYr} (registry: ${year}) — registry の year 更新を検討\n`,
        );
      }
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
    writeFileSync(OUT, yamlText, "utf8");
    console.log(`wrote ${OUT} (${Object.keys(generated).length} conferences)`);
  } else {
    console.log(`--- dry-run: ${OUT} (${Object.keys(generated).length} conferences) ---`);
    console.log(yamlText);
  }
  return 0;
}

const isMain = process.argv[1]?.endsWith("fetch-primary.ts");
if (isMain) {
  runFetchPrimary(process.argv.includes("--apply")).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err);
      process.exitCode = 1;
    },
  );
}
