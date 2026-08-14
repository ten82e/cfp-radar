/**
 * Autonomous Discovery Engine for Niche Conferences & Journals.
 *
 * This module searches external academic CFP sources (DBLP, wikiCFP, DBWorld,
 * EasyChair, OpenReview, IEEE ComSoc, IEICE, IPSJ) for niche conferences,
 * workshops, symposia, and journal Call for Papers in HPC, Systems, Networking,
 * AI, and Security.  Ported from scripts/discover.py (cfp-radar).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decode } from "html-entities";
import { dump as dumpYaml, load as loadYaml } from "js-yaml";
import { slug } from "./model.ts";

const ROOT = join(import.meta.dirname, "..");

// Domain-specific keywords for classifying niche venues
export const DOMAIN_KEYWORDS: Record<string, string[]> = {
  hpc: [
    "hpc",
    "supercomputing",
    "parallel computing",
    "high performance",
    "interconnect",
    "cluster computing",
    "grid computing",
    "heterogeneous computing",
  ],
  systems: [
    "operating systems",
    "storage systems",
    "embedded systems",
    "real-time",
    "computer architecture",
    "cloud computing",
    "edge computing",
    "virtualization",
    "compiler",
    "code generation",
    "memory systems",
    "dependable systems",
  ],
  networking: [
    "computer networks",
    "network protocols",
    "programmable networks",
    "wireless networking",
    "sdn",
    "p4",
    "network management",
    "mobile computing",
    "optical networking",
  ],
  ai: [
    "machine learning systems",
    "sysml",
    "graph neural networks",
    "ai systems",
    "deep learning systems",
    "efficient ai",
    "neural networks",
    "robotics systems",
  ],
  security: [
    "system security",
    "network security",
    "privacy",
    "hardware security",
    "cryptography",
    "binary analysis",
    "confidential computing",
    "trustworthy ai",
  ],
};

// Indicators of niche/obscure venues & journals
export const NICHE_KEYWORDS = [
  "workshop",
  "symposium",
  "journal",
  "special issue",
  "letters",
  "transactions",
  "regional",
  "open call",
  "forum",
  "work-in-progress",
  "short papers",
];

// wikiCFP のカテゴリページ (?conference=<cat>) と cfp-radar カテゴリの対応。
export const WIKICFP_CATEGORY_MAP: Record<string, string[]> = {
  hpc: ["parallel", "high", "grid", "performance", "computational"],
  networking: [
    "networks",
    "networking",
    "communications",
    "internet",
    "wireless",
    "network",
    "telecommunications",
    "mobile",
    "ubiquitous",
    "pervasive",
    "sensor",
  ],
  systems: [
    "systems",
    "architecture",
    "operating",
    "distributed",
    "embedded",
    "cloud",
    "edge",
    "compilers",
    "programming",
    "software",
    "dependability",
    "reliability",
    "blockchain",
    "cyber-physical",
    "safety",
  ],
  ai: [
    "artificial",
    "machine",
    "deep",
    "neural",
    "intelligent",
    "cognitive",
    "fuzzy",
    "evolutionary",
    "robotics",
    "agents",
    "multi-agent",
    "pattern",
  ],
  security: ["security", "cybersecurity", "privacy", "cryptography", "cyber", "trust"],
  db: [
    "database",
    "databases",
    "data",
    "big",
    "knowledge",
    "semantic",
    "semantics",
    "ontologies",
    "ontology",
  ],
  graphics: ["graphics", "multimedia", "visualization", "image", "virtual"],
  hci: ["human", "human-computer"],
  theory: [
    "theory",
    "algorithms",
    "theoretical",
    "complexity",
    "formal",
    "verification",
    "logic",
    "optimization",
    "graph",
  ],
};

export interface Candidate {
  key: string;
  title: string;
  full_name: string;
  link: string;
  categories: string[];
  tags: string[];
  source_type: string; // 'conference' | 'journal' | 'special_issue'
  evidence_url: string;
  date_text: string;
  place: string;
  deadlines: Array<Record<string, unknown>>;
}

export function makeCandidate(
  partial: Partial<Candidate> & {
    key: string;
    title: string;
    full_name: string;
    link: string;
    categories: string[];
  },
): Candidate {
  return {
    tags: ["niche"],
    source_type: "conference",
    evidence_url: "",
    date_text: "",
    place: "",
    deadlines: [],
    ...partial,
  };
}

/** Convert a candidate into data/extra.yaml format. */
export function toYamlDict(c: Candidate): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    key: c.key,
    title: c.title,
    full_name: c.full_name,
    link: c.link,
    categories: c.categories,
  };
  if (c.tags.length > 0) entry.tags = c.tags;
  const editions: unknown[] = [];
  if (c.date_text || c.place || c.deadlines.length > 0) {
    const m = /(20\d\d)/.exec(c.date_text);
    const year = m ? Number(m[1]) : 2026;
    editions.push({
      year,
      id: `${c.key}${year % 100}`,
      link: c.link,
      place: c.place || "",
      date_text: c.date_text || "",
      deadlines: c.deadlines,
    });
  }
  entry.editions = editions;
  return entry;
}

/** Extract structured deadline dates from text if ISO or standard date formats appear. */
export function extractDeadlinesFromText(text: string): Array<Record<string, unknown>> {
  const deadlines: Array<Record<string, unknown>> = [];
  const matches = text.match(/\b202[6-9]-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\b/g) ?? [];
  if (matches.length > 0) {
    deadlines.push({
      kind: "paper",
      label: "Submission Deadline",
      date: `${matches[0]} 23:59:00`,
      tz: "AoE",
    });
    if (matches.length > 1) {
      deadlines.push({
        kind: "notification",
        label: "Notification Date",
        date: `${matches[1]} 23:59:00`,
        tz: "AoE",
      });
    }
  }
  return deadlines;
}

interface WikiCfpEntry {
  key: string;
  title: string;
  full_name: string;
  link: string;
  categories: string[];
  date_text: string;
  place: string;
  year: number;
}

/** wikiCFP カテゴリページをパースしてエントリ dict のリストを返す。 */
export function parseWikiCfpHtml(
  html: string,
  categories: string[],
  minYear: number,
): WikiCfpEntry[] {
  const rows = html.match(/<tr[^>]*>([\s\S]*?)<\/tr>/g) ?? [];
  const entries: WikiCfpEntry[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const m = /<a href="([^"]*event\.showcfp[^"]*)">([^<]+)<\/a>/.exec(row);
    if (!m) continue;
    const href = decode(m[1]);
    const title = decode(m[2]).trim();
    // full name = イベント行の 2 番目の td
    const tds = row.match(/<td[^>]*>([\s\S]*?)<\/td>/g) ?? [];
    let fullName = "";
    for (const td of tds.slice(1)) {
      const txt = td
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (txt && !txt.includes("checkbox")) {
        fullName = txt;
        break;
      }
    }
    if (!fullName || i + 1 >= rows.length) continue;
    // ディテール行: when / where / deadline
    const detailRows = rows[i + 1].match(/<td[^>]*>([\s\S]*?)<\/td>/g) ?? [];
    const cells = detailRows
      .map((c) => c.replace(/<[^>]+>/g, " "))
      .map((c) => c.replace(/\s+/g, " ").trim())
      .filter((c) =>
        c
          .replace(/<[^>]+>/g, "")
          .replace(/\s+/g, " ")
          .trim(),
      );
    if (cells.length < 3) continue;
    const [when, where, deadline] = cells;
    void when;
    if (deadline === "" || deadline === "N/A") continue;
    let year = minYear;
    const tm = /(20\d\d)/.exec(title);
    if (tm) {
      year = Number(tm[1]);
    } else {
      const dm = /(20\d\d)/.exec(deadline);
      if (dm) year = Number(dm[1]);
    }
    if (year < minYear) continue;
    entries.push({
      key: slug(title),
      title,
      full_name: fullName,
      link: `https://www.wikicfp.com${href}`,
      categories: [...categories],
      date_text: deadline,
      place: where !== "" && where !== "N/A" ? where : "",
      year,
    });
  }
  return entries;
}

/** Date.UTC は不正な年月日を繰り上げてしまうため、暦の妥当性を検証してから返す。 */
function validUtcDate(year: number, month: number, day: number): Date | null {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return d;
}

/** 'Aug 15, 2026 (Aug 1, 2026)' または '31 December 2026' 形式の締切を Date に変換。 */
export function parseDeadlineText(dateText: string): Date | null {
  const months: Record<string, number> = {
    Jan: 1,
    Feb: 2,
    Mar: 3,
    Apr: 4,
    May: 5,
    Jun: 6,
    Jul: 7,
    Aug: 8,
    Sep: 9,
    Oct: 10,
    Nov: 11,
    Dec: 12,
  };
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(dateText);
  if (m) return validUtcDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(dateText);
  if (m) return validUtcDate(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /(\d{1,2})\s+([A-Z][a-z]{2})\w*\s+(20\d\d)/.exec(dateText);
  if (m && m[2] in months) {
    return validUtcDate(Number(m[3]), months[m[2]], Number(m[1]));
  }
  m = /([A-Z][a-z]{2})\w*\s+(\d{1,2}),?\s*(20\d\d)?/.exec(dateText);
  if (m && m[1] in months) {
    const year = m[3] ? Number(m[3]) : new Date().getUTCFullYear();
    return validUtcDate(year, months[m[1]], Number(m[2]));
  }
  return null;
}

export function deadlineIsFuture(dateText: string, today: Date): boolean {
  const d = parseDeadlineText(dateText);
  return d !== null && d.getTime() >= today.getTime();
}

async function fetchText(url: string, userAgent: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": userAgent },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

const DISCOVER_UA = "Mozilla/5.0 (cfp-radar-discoverer)";
const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** wikiCFP カテゴリページを取得してパースする(ネットワーク層)。 */
async function discoverFromWikiCfpUrls(
  categories: string[],
  minYear: number,
): Promise<WikiCfpEntry[]> {
  const entries: WikiCfpEntry[] = [];
  const today = new Date();
  for (const cat of categories) {
    for (let page = 1; page <= 3; page++) {
      const url = `http://www.wikicfp.com/cfp/call?conference=${cat}&page=${page}`;
      let pageEntries: WikiCfpEntry[] = [];
      try {
        await sleep(400); // リクエスト過多での一時ブロック回避
        const html = await fetchText(url, DISCOVER_UA, 15_000);
        pageEntries = parseWikiCfpHtml(html, [cat], minYear);
      } catch {
        break; // 1 カテゴリ 1 ページの失敗で全体を止めない
      }
      const future = pageEntries.filter((e) => deadlineIsFuture(e.date_text, today));
      entries.push(...future);
      if (future.length === 0) break; // 締切昇順: ここから先はすべて過去締切
    }
  }
  return entries;
}

interface DbworldRow {
  subject: string;
  href: string;
}

/** DBWorld アーカイブのメッセージ一覧から CFP 関連の (subject, URL) を返す。 */
export function parseDbworldHtml(html: string): DbworldRow[] {
  const out: DbworldRow[] = [];
  for (const row of html.match(/<TR VALIGN=TOP>[\s\S]*?<\/TR>/g) ?? []) {
    const m = /<A HREF=([^>]+)>([^<]+)<\/A>/.exec(row);
    if (!m) continue;
    const href = m[1].trim();
    const subject = decode(m[2]).trim();
    if (
      /call for (papers?|participation)|deadline|reminder|last call|special issue/i.test(subject)
    ) {
      out.push({ subject, href });
    }
  }
  return out;
}

/** DBWorld subject から会議名を抽出し、(会議名, source_type) を返す。 */
export function cleanDbworldTitle(subject: string): [string, string] {
  let t = subject.trim();
  t = t.replace(/^(\[[^\]]*\]\s*)+/, ""); // [DEADLINE EXTENDED] 等 (複数)
  t = t.replace(/^(?:Last\s+)?(?:Call for Papers?|CfP|CFP)\s*:?\s*/i, "");
  t = t.replace(
    /^(?:DEADLINE EXTENSION|Extended (?:Submission )?Deadline|Deadline\s+(?:Extended|Extension|Approaching))\s*:?\s*/i,
    "",
  );
  t = t.replace(/\s*(?:[|:]\s*)?(?:Final\s+|Last\s+)?Call for\b.*$/i, "");
  t = t.replace(/\s*\|\|?.*$/, ""); // "|" 区切り以降
  t = t.replace(/\s*:\s*[^()]*\bDeadline\b.*$/i, "");
  t = t.replace(/\s*[-–]\s*(?:Deadline|Extended\s+deadline).*$/i, "");
  t = t
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s\-:|–]+|[\s\-:|–]+$/g, "");
  if (t.length < 4) return ["", "conference"];
  const sourceType = /special issue|transactions|journal/i.test(subject) ? "journal" : "conference";
  return [t, sourceType];
}

/** DBWorld メーリス public アーカイブから CFP 候補を抽出する。 */
export async function discoverFromDbworld(
  minYear: number,
): Promise<Array<Record<string, unknown>>> {
  const url = "https://dbworld.sigmod.org/browse.html";
  const html = await fetchText(url, DISCOVER_UA, 20_000);

  const entries: Array<Record<string, unknown>> = [];
  for (const { subject, href } of parseDbworldHtml(html)) {
    const [cleaned, sourceType] = cleanDbworldTitle(subject);
    if (!cleaned) continue;
    const m = /(20\d\d)/.exec(cleaned);
    const year = m ? Number(m[1]) : minYear;
    if (year < minYear) continue;
    entries.push({
      key: slug(cleaned),
      title: cleaned,
      full_name: cleaned,
      link: href,
      categories: [], // タイトルからの自動判定は誤爆が多い。レビュー時付与
      source_type: sourceType,
      date_text: "",
      place: "",
      year,
    });
  }
  return entries;
}

interface EasyChairRow {
  title: string;
  full_name: string;
  place: string;
  date_text: string;
  start: string;
  topics: string[];
  url: string;
}

/** EasyChair Smart CFP 一覧 (easychair.org/cfp/) のテーブル行をパースする。 */
export function parseEasyChairCfpHtml(html: string): EasyChairRow[] {
  const out: EasyChairRow[] = [];
  for (const tbody of html.match(/<tbody>([\s\S]*?)<\/tbody>/g) ?? []) {
    for (const tr of tbody.match(/<tr[^>]*>([\s\S]*?)<\/tr>/g) ?? []) {
      const cells = tr.match(/<td[^>]*>([\s\S]*?)<\/td>/g) ?? [];
      if (cells.length < 5) continue;
      const m = /href="(\/cfp\/[^"]+)"[^>]*>([^<]+)</.exec(cells[0] ?? "");
      if (!m) continue;
      const text = (c: string): string => decode(c.replace(/<[^>]+>/g, "")).trim();
      const topics =
        cells.length > 5
          ? [...(cells[5].match(/<span class="tag[^"]*">([^<]+)<\/span>/g) ?? [])].map((t) =>
              decode(t.replace(/<span class="tag[^"]*">/, "").replace(/<\/span>/, "")).trim(),
            )
          : [];
      out.push({
        title: decode(m[2]).trim(),
        full_name: text(cells[1] ?? "") || decode(m[2]).trim(),
        place: text(cells[2] ?? ""),
        date_text: text(cells[3] ?? ""),
        start: text(cells[4] ?? ""),
        topics,
        url: `https://easychair.org${m[1]}`,
      });
    }
  }
  return out;
}

/** EasyChair 候補がユーザー分野に属するか簡易判定する。 */
export function inDomain(text: string): boolean {
  const t = ` ${text.toLowerCase()} `;
  return [
    "network",
    "wireless",
    "communication",
    "telecom",
    "internet",
    "mobile",
    "iot",
    "system",
    "distributed",
    "cloud",
    "edge",
    "embedded",
    "operating",
    "architecture",
    "storage",
    "virtualization",
    "compiler",
    "hpc",
    "supercomputing",
    "parallel",
    "cluster",
    "grid",
    "computational",
    "performance",
    "security",
    "cyber",
    "privacy",
    "cryptograph",
    "cryptolog",
    "trust",
    "database",
    "data ",
    "knowledge",
    "semantic",
    "ontolog",
    "intelligent",
    "artificial intelligence",
    "machine learning",
    "deep learning",
    "llm",
    "nlp",
    "vision",
    " ai ",
    "robotics",
    "automation",
  ].some((k) => t.includes(k));
}

/** EasyChair Smart CFP 一覧から締切登録済みの候補を抽出する。 */
export async function discoverFromEasyChair(
  minYear: number,
): Promise<Array<Record<string, unknown>>> {
  const url = "https://easychair.org/cfp/";
  const html = await fetchText(url, DISCOVER_UA, 25_000);
  const entries: Array<Record<string, unknown>> = [];
  for (const e of parseEasyChairCfpHtml(html)) {
    if (!e.date_text) continue; // 締切未登録は候補にしない
    const dm = /(20\d\d)/.exec(e.date_text);
    if (dm && Number(dm[1]) < minYear) continue;
    const m = /20\d\d/.exec(`${e.title} ${e.full_name}`);
    const year = m ? Number(m[0]) : minYear;
    if (year < minYear) continue;
    if (!inDomain(`${e.title} ${e.full_name} ${e.topics.join(" ")}`)) continue;
    entries.push({
      key: slug(e.title),
      title: e.title,
      full_name: e.full_name,
      link: e.url,
      categories: [], // レビュー時付与
      source_type: "conference",
      date_text: e.date_text,
      place: e.place,
      year,
    });
  }
  return entries;
}

/** IEEE ComSoc CFP ページのテーブルからオープン特集号を抽出する (純関数)。 */
export function parseComsocCfpHtml(
  html: string,
  journalName: string,
  pageUrl: string,
): Array<Record<string, unknown>> {
  const rows = html.match(/<tr[^>]*>([\s\S]*?)<\/tr>/g) ?? [];
  const entries: Array<Record<string, unknown>> = [];
  for (const row of rows.slice(1)) {
    // ヘッダ行をスキップ
    const cells = (row.match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g) ?? []).map((c) =>
      c
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim(),
    );
    if (cells.length < 3 || !cells[0] || !cells[2]) continue;
    const [topic, , deadline] = cells;
    if (deadline.toLowerCase().includes("closed")) continue;
    if (
      topic.toLowerCase().startsWith("paper topic") ||
      deadline.toLowerCase().includes("deadline")
    ) {
      continue; // ヘッダ行 (一部ページは表内に繰り返す)
    }
    const title = `${topic}（${journalName} 特集号）`;
    const dm = /(20\d\d)/.exec(deadline);
    entries.push({
      key: slug(title),
      title,
      full_name: title,
      link: pageUrl,
      categories: [],
      source_type: "special_issue",
      date_text: deadline,
      place: "",
      year: dm ? Number(dm[1]) : 0,
    });
  }
  return entries;
}

/** IEEE ComSoc 誌のオープン特集号 CFP を候補化する (ネットワーク層)。 */
export async function discoverFromComsocCfps(
  minYear: number,
): Promise<Array<Record<string, unknown>>> {
  const pages: Array<[string, string]> = [
    ["journals/ieee-tnsm", "IEEE TNSM"],
    ["journals/ieee-tccn", "IEEE TCCN"],
    ["magazines/ieee-network", "IEEE Network"],
    ["magazines/ieee-communications-magazine", "IEEE Communications Magazine"],
    ["magazines/ieee-wireless-communications", "IEEE Wireless Communications"],
  ];
  const entries: Array<Record<string, unknown>> = [];
  for (const [path, jname] of pages) {
    const url = `https://www.comsoc.org/publications/${path}/cfp`;
    let html: string;
    try {
      await sleep(500);
      html = await fetchText(url, DISCOVER_UA, 20_000);
    } catch {
      continue; // 1 誌の失敗で全体を止めない
    }
    for (const e of parseComsocCfpHtml(html, jname, url)) {
      const dm = /(20\d\d)/.exec(String(e.date_text));
      if (dm && Number(dm[1]) < minYear) continue; // 過去締切
      entries.push(e);
    }
  }
  return entries;
}

/** IEICE 特集号 CFP 一覧 (journals.php) から締切付き特集号を抽出する (純関数)。 */
export function parseIeiceCfpHtml(html: string, pageUrl: string): Array<Record<string, unknown>> {
  const rows = html.match(/<tr[^>]*>([\s\S]*?)<\/tr>/g) ?? [];
  const entries: Array<Record<string, unknown>> = [];
  for (const row of rows.slice(1)) {
    // ヘッダ行をスキップ
    const cells = (row.match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g) ?? []).map((c) =>
      decode(
        c
          .replace(/<[^>]+>/g, "")
          .replace(/\s+/g, " ")
          .trim(),
      ),
    );
    if (cells.length < 3 || !cells[0] || !cells[2]) continue;
    const [journal, deadline, section] = cells;
    if (!/^\d{4}-\d{1,2}-\d{1,2}$/.test(deadline)) continue;
    const title = `${section}（${journal} 特集号）`;
    entries.push({
      key: slug(title),
      title,
      full_name: title,
      link: pageUrl,
      categories: [],
      source_type: "special_issue",
      date_text: deadline,
      place: "",
      year: Number(deadline.slice(0, 4)),
    });
  }
  return entries;
}

/** IEICE 論文誌の特集号 CFP 一覧を候補化する (ネットワーク層)。 */
export async function discoverFromIeiceCfps(
  minYear: number,
): Promise<Array<Record<string, unknown>>> {
  const url = "https://www.ieice.org/eng_r/information/schedule/journals.php";
  const entries: Array<Record<string, unknown>> = [];
  let html: string;
  try {
    // IEICE はカスタム UA を 403 で拒否するため Mozilla 系 UA を使う
    html = await fetchText(url, MAC_UA, 20_000);
  } catch {
    return entries; // 取得失敗で全体を止めない
  }
  for (const e of parseIeiceCfpHtml(html, url)) {
    if (Number(e.year) < minYear) continue;
    entries.push(e);
  }
  return entries;
}

/** IPSJ 論文誌ジャーナルの特集論文募集リンクから締切付き特集号を抽出する (純関数)。 */
export function parseIpsjCfpHtml(html: string, pageUrl: string): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = [];
  for (const m of html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const url = m[1];
    const inner = m[2];
    const sm = /論文誌「([^」]+)」特集/.exec(inner);
    if (!sm) continue;
    const dm = /投稿締切[:：]\s*(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(inner);
    if (!dm) continue;
    const deadline = `${Number(dm[1]).toString().padStart(4, "0")}-${Number(dm[2]).toString().padStart(2, "0")}-${Number(dm[3]).toString().padStart(2, "0")}`;
    const title = `${sm[1]}（IPSJ 論文誌 特集号）`;
    // key は CFP ファイル名由来 (ipsj-27-p) で一意化。
    const fname = url.split("/").pop()?.split(".")[0]?.toLowerCase() ?? "cfp";
    entries.push({
      key: `ipsj-${fname}`,
      title,
      full_name: title,
      link: url.startsWith("http")
        ? url
        : `${pageUrl.split("/").slice(0, -1).join("/")}/${url.replace(/^\//, "")}`,
      categories: [],
      source_type: "special_issue",
      date_text: deadline,
      place: "",
      year: Number(dm[1]),
    });
  }
  return entries;
}

/** IPSJ 論文誌ジャーナルの特集論文募集を候補化する (ネットワーク層)。 */
export async function discoverFromIpsjCfps(
  minYear: number,
): Promise<Array<Record<string, unknown>>> {
  const url = "https://www.ipsj.or.jp/journal/index.html";
  const entries: Array<Record<string, unknown>> = [];
  let html: string;
  try {
    html = await fetchText(url, MAC_UA, 20_000);
  } catch {
    return entries; // 取得失敗で全体を止めない
  }
  for (const e of parseIpsjCfpHtml(html, url)) {
    if (Number(e.year) < minYear) continue;
    entries.push(e);
  }
  return entries;
}

/** 購読メーリス (IMAP) の受信トレイから CFP メールを抽出する。 */
export async function discoverFromImap(minYear: number): Promise<Array<Record<string, unknown>>> {
  const host = process.env.CFP_IMAP_HOST;
  const user = process.env.CFP_IMAP_USER;
  const pw = process.env.CFP_IMAP_PASS;
  if (!host || !user || !pw) {
    return []; // GitHub Actions では Secrets 未設定なら自動スキップ
  }
  const { ImapFlow } = await import("imapflow");
  const client = new ImapFlow({
    host,
    port: 993,
    secure: true,
    auth: { user, pass: pw },
    logger: false,
  });
  const entries: Array<Record<string, unknown>> = [];
  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const searchResult = await client.search({ all: true });
      const ids = searchResult === false ? [] : searchResult;
      const recent = ids.slice(-50); // 最近 50 通のみ
      for (const id of recent) {
        const msg = await client.fetchOne(id, { envelope: true });
        if (msg === false) continue;
        const subject = msg.envelope?.subject ?? "";
        if (!/call for (papers?|participation)|cfp|deadline|reminder|last call/i.test(subject))
          continue;
        const [cleaned, sourceType] = cleanDbworldTitle(subject);
        if (!cleaned) continue;
        const m2 = /(20\d\d)/.exec(cleaned);
        const year = m2 ? Number(m2[1]) : minYear;
        if (year < minYear) continue;
        entries.push({
          key: slug(cleaned),
          title: cleaned,
          full_name: cleaned,
          link: "", // 本文は持たない。レビュー時に公式サイトで裏取り
          categories: [],
          source_type: sourceType,
          date_text: "",
          place: "",
          year,
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
  return entries;
}

export class NicheDiscoverer {
  private readonly rootDir: string;
  readonly knownKeys = new Set<string>();
  private readonly knownTitles = new Set<string>();

  constructor(rootDir: string = ROOT) {
    this.rootDir = rootDir;
    this.loadKnownVenues();
  }

  /** Load tracked keys and titles from config.yaml, extra.yaml, and snapshot. */
  private loadKnownVenues(): void {
    // 1. config.yaml taxonomy
    const configPath = join(this.rootDir, "config.yaml");
    try {
      const config = (loadYaml(readFileSync(configPath, "utf8")) as Record<string, unknown>) ?? {};
      const taxonomy = (config.taxonomy as Record<string, unknown>) ?? {};
      for (const catData of Object.values(taxonomy)) {
        if (typeof catData === "object" && catData !== null) {
          for (const v of ((catData as Record<string, unknown>).venues as string[] | null) ?? []) {
            this.knownKeys.add(slug(v));
          }
        }
      }
    } catch {
      // config.yaml が無い環境 (テスト) では空のまま
    }

    // 2. data/extra.yaml
    const extraPath = join(this.rootDir, "data", "extra.yaml");
    try {
      const extra = (loadYaml(readFileSync(extraPath, "utf8")) as Record<string, unknown>) ?? {};
      for (const c of (extra.conferences as unknown[] | null) ?? []) {
        if (typeof c === "object" && c !== null) {
          const rec = c as Record<string, unknown>;
          if ("key" in rec) this.knownKeys.add(slug(String(rec.key)));
          if ("title" in rec) this.knownTitles.add(String(rec.title).toLowerCase());
        }
      }
    } catch {
      // ファイルが無いテスト環境では空のまま
    }

    // 3. data/snapshot.json
    const snapshotPath = join(this.rootDir, "data", "snapshot.json");
    try {
      const snap = JSON.parse(readFileSync(snapshotPath, "utf8")) as { conferences?: unknown[] };
      for (const c of snap.conferences ?? []) {
        if (typeof c === "object" && c !== null) {
          const rec = c as Record<string, unknown>;
          if ("key" in rec) this.knownKeys.add(slug(String(rec.key)));
          if ("title" in rec) this.knownTitles.add(String(rec.title).toLowerCase());
        }
      }
    } catch {
      // 無ければ無視
    }
  }

  /** Check if candidate key or title is already in our repository. */
  isAlreadyTracked(keyOrTitle: string): boolean {
    const s = slug(keyOrTitle);
    if (this.knownKeys.has(s)) return true;
    if (this.knownTitles.has(keyOrTitle.toLowerCase())) return true;
    // 年付きタイトル (例: "CIDR 2027") は年を除いて比較
    const yearless = s.replace(/\b20\d\d\b/g, "").replace(/^-+|-+$/g, "");
    if (yearless && this.knownKeys.has(yearless)) return true;
    return false;
  }

  /** Classify candidate text into target categories. */
  classifyCategory(text: string): string[] {
    const textLower = text.toLowerCase();
    const matched: string[] = [];
    for (const [cat, keywords] of Object.entries(DOMAIN_KEYWORDS)) {
      if (keywords.some((kw) => textLower.includes(kw))) matched.push(cat);
    }
    return matched.length > 0 ? matched : ["systems"];
  }

  /** Query DBLP API for venue/publication candidates matching query. */
  async discoverFromDblp(query = "workshop", maxResults = 30): Promise<Candidate[]> {
    const url = `https://dblp.org/search/venue/api?q=${encodeURIComponent(query)}&format=json&h=${maxResults}`;
    const candidates: Candidate[] = [];
    try {
      const html = await fetchText(url, DISCOVER_UA, 10_000);
      const data = JSON.parse(html) as {
        result?: { hits?: { hit?: Array<{ info?: Record<string, unknown> }> } };
      };
      const hits = data.result?.hits?.hit ?? [];
      for (const hit of hits) {
        const info = hit.info ?? {};
        const venueTitle = String(info.venue ?? info.acronym ?? "");
        const venueUrl = String(info.url ?? "");
        const venueName = String(info.acronym ?? venueTitle);

        if (!venueTitle || this.isAlreadyTracked(venueTitle)) continue;

        const candKey = slug(venueName || venueTitle);
        if (!candKey || this.isAlreadyTracked(candKey)) continue;

        const categories = this.classifyCategory(venueTitle);
        const sourceType =
          venueTitle.toLowerCase().includes("journal") ||
          venueTitle.toLowerCase().includes("transactions")
            ? "journal"
            : "conference";

        candidates.push(
          makeCandidate({
            key: candKey,
            title: venueName || venueTitle.toUpperCase(),
            full_name: venueTitle,
            link: venueUrl || `https://dblp.org/db/conf/${candKey}/index.html`,
            categories,
            tags: ["niche", sourceType],
            source_type: sourceType,
            evidence_url: venueUrl,
          }),
        );
        this.knownKeys.add(candKey);
      }
    } catch {
      // Soft fallback on network error
    }
    return candidates;
  }

  /** Query OpenReview API v2 for venue candidates. */
  async discoverFromOpenreview(query = "workshop"): Promise<Candidate[]> {
    const url = "https://api2.openreview.net/venues";
    const candidates: Candidate[] = [];
    try {
      const html = await fetchText(url, DISCOVER_UA, 10_000);
      const data = JSON.parse(html) as { venues?: unknown[] };
      for (const v of data.venues ?? []) {
        if (typeof v !== "string") continue;
        if (!v.toLowerCase().includes(query.toLowerCase())) continue;
        const candKey = slug(v);
        if (!candKey || this.isAlreadyTracked(candKey) || this.isAlreadyTracked(v)) continue;

        const categories = this.classifyCategory(v);
        candidates.push(
          makeCandidate({
            key: candKey,
            title: v.split("/").pop()?.toUpperCase() ?? candKey,
            full_name: v,
            link: `https://openreview.net/group?id=${v}`,
            categories,
            tags: ["niche", "workshop", "openreview"],
            source_type: "conference",
            evidence_url: `https://openreview.net/group?id=${v}`,
          }),
        );
        this.knownKeys.add(candKey);
      }
    } catch {
      // Soft fallback on network error
    }
    return candidates;
  }

  /** Run full autonomous discovery across multiple sources. */
  async runDiscovery(categories: string[] | null = null, minYear = 2026): Promise<Candidate[]> {
    const results: Candidate[] = [];

    // 1. DBLP queries
    const queries = [
      "workshop",
      "symposium",
      "journal",
      "systems",
      "hpc",
      "networking",
      "security",
    ];
    for (const q of queries) {
      results.push(...(await this.discoverFromDblp(q, 20)));
    }

    // 2. OpenReview queries
    const orQueries = ["workshop", "symposium", "workshop 2026"];
    for (const q of orQueries) {
      results.push(...(await this.discoverFromOpenreview(q)));
    }

    // 3. wikiCFP: 各 cfp-radar カテゴリの wikiCFP カテゴリ全部を取得。
    for (const [cat, wikicfpCats] of Object.entries(WIKICFP_CATEGORY_MAP)) {
      if (categories && !categories.includes(cat)) continue;
      for (const entry of await discoverFromWikiCfpUrls(wikicfpCats, minYear)) {
        const candKey = entry.key;
        if (this.isAlreadyTracked(candKey) || this.isAlreadyTracked(entry.full_name)) continue;
        results.push(
          makeCandidate({
            key: candKey,
            title: entry.title,
            full_name: entry.full_name,
            link: entry.link,
            categories: entry.categories,
            tags: ["niche", "wikicfp"],
            source_type: /journal|transactions|letters/.test(entry.full_name.toLowerCase())
              ? "journal"
              : "conference",
            evidence_url: "https://www.wikicfp.com",
            date_text: entry.date_text,
            place: entry.place,
          }),
        );
        this.knownKeys.add(candKey);
      }
    }

    // 4. DBWorld
    try {
      for (const entry of await discoverFromDbworld(minYear)) {
        const candKey = String(entry.key);
        if (this.isAlreadyTracked(candKey) || this.isAlreadyTracked(String(entry.full_name)))
          continue;
        results.push(
          makeCandidate({
            key: candKey,
            title: String(entry.title),
            full_name: String(entry.full_name),
            link: String(entry.link),
            categories: entry.categories as string[],
            tags: ["niche", "dbworld"],
            source_type: String(entry.source_type),
            evidence_url: "https://dbworld.sigmod.org/browse.html",
            date_text: String(entry.date_text),
            place: String(entry.place),
          }),
        );
        this.knownKeys.add(candKey);
      }
    } catch {
      // アーカイブ障害で全体を止めない
    }

    // 5. EasyChair Smart CFP
    try {
      for (const entry of await discoverFromEasyChair(minYear)) {
        const candKey = String(entry.key);
        if (this.isAlreadyTracked(candKey) || this.isAlreadyTracked(String(entry.full_name)))
          continue;
        results.push(
          makeCandidate({
            key: candKey,
            title: String(entry.title),
            full_name: String(entry.full_name),
            link: String(entry.link),
            categories: entry.categories as string[],
            tags: ["niche", "easychair"],
            source_type: String(entry.source_type),
            evidence_url: "https://easychair.org/cfp/",
            date_text: String(entry.date_text),
            place: String(entry.place),
          }),
        );
        this.knownKeys.add(candKey);
      }
    } catch {
      // 一覧取得失敗で全体を止めない
    }

    // 6. IMAP 購読メーリス (任意)
    try {
      for (const entry of await discoverFromImap(minYear)) {
        const candKey = String(entry.key);
        if (this.isAlreadyTracked(candKey) || this.isAlreadyTracked(String(entry.full_name)))
          continue;
        results.push(
          makeCandidate({
            key: candKey,
            title: String(entry.title),
            full_name: String(entry.full_name),
            link: String(entry.link),
            categories: entry.categories as string[],
            tags: ["niche", "imap"],
            source_type: String(entry.source_type),
            date_text: String(entry.date_text),
            place: String(entry.place),
          }),
        );
        this.knownKeys.add(candKey);
      }
    } catch {
      // 認証失敗等で全体を止めない
    }

    // 7. IEEE ComSoc 誌のオープン特集号 CFP
    try {
      for (const entry of await discoverFromComsocCfps(minYear)) {
        const candKey = String(entry.key);
        if (this.isAlreadyTracked(candKey) || this.isAlreadyTracked(String(entry.full_name)))
          continue;
        results.push(
          makeCandidate({
            key: candKey,
            title: String(entry.title),
            full_name: String(entry.full_name),
            link: String(entry.link),
            categories: entry.categories as string[],
            tags: ["niche", "special-issue"],
            source_type: String(entry.source_type),
            date_text: String(entry.date_text),
            place: String(entry.place),
          }),
        );
        this.knownKeys.add(candKey);
      }
    } catch {
      // 特集号一覧取得失敗で全体を止めない
    }

    // 8. IEICE 論文誌の特集号 CFP
    try {
      for (const entry of await discoverFromIeiceCfps(minYear)) {
        const candKey = String(entry.key);
        if (this.isAlreadyTracked(candKey) || this.isAlreadyTracked(String(entry.full_name)))
          continue;
        results.push(
          makeCandidate({
            key: candKey,
            title: String(entry.title),
            full_name: String(entry.full_name),
            link: String(entry.link),
            categories: entry.categories as string[],
            tags: ["niche", "special-issue"],
            source_type: String(entry.source_type),
            date_text: String(entry.date_text),
            place: String(entry.place),
          }),
        );
        this.knownKeys.add(candKey);
      }
    } catch {
      // 特集号一覧取得失敗で全体を止めない
    }

    // 9. IPSJ 論文誌ジャーナルの特集論文募集
    try {
      for (const entry of await discoverFromIpsjCfps(minYear)) {
        const candKey = String(entry.key);
        if (this.isAlreadyTracked(candKey) || this.isAlreadyTracked(String(entry.full_name)))
          continue;
        results.push(
          makeCandidate({
            key: candKey,
            title: String(entry.title),
            full_name: String(entry.full_name),
            link: String(entry.link),
            categories: entry.categories as string[],
            tags: ["niche", "special-issue"],
            source_type: String(entry.source_type),
            date_text: String(entry.date_text),
            place: String(entry.place),
          }),
        );
        this.knownKeys.add(candKey);
      }
    } catch {
      // 特集号一覧取得失敗で全体を止めない
    }

    // 10. Known niche candidate registry (fallback / curated candidates)
    const curated = [
      makeCandidate({
        key: "resound",
        title: "RESOUND",
        full_name: "International Workshop on Resilient Systems and Dependable Operating Systems",
        link: "https://www.resound-workshop.org/",
        categories: ["systems", "security"],
        tags: ["niche", "workshop"],
        place: "Europe",
        date_text: "September 14, 2026",
      }),
      makeCandidate({
        key: "netpl",
        title: "NetPL",
        full_name: "Workshop on Networking and Programming Languages",
        link: "https://netpl.github.io/",
        categories: ["networking", "systems"],
        tags: ["niche", "workshop"],
        place: "Virtual",
        date_text: "October 10, 2026",
      }),
      makeCandidate({
        key: "taco-special",
        title: "ACM TACO Special Issues",
        full_name: "ACM Transactions on Architecture and Code Optimization Special Call for Papers",
        link: "https://dl.acm.org/journal/taco",
        categories: ["systems", "hpc"],
        tags: ["niche", "journal"],
        source_type: "journal",
      }),
    ];
    for (const cand of curated) {
      if (!this.isAlreadyTracked(cand.key) && !this.isAlreadyTracked(cand.title)) {
        results.push(cand);
        this.knownKeys.add(cand.key);
      }
    }

    // Filter by requested categories if specified
    if (categories) {
      return results.filter((c) => c.categories.some((cat) => categories.includes(cat)));
    }
    return results;
  }
}

/** Format discovered candidates into YAML string compatible with extra.yaml. */
export function formatDiscoveredYaml(candidates: Candidate[]): string {
  return dumpYaml({ conferences: candidates.map(toYamlDict) }, { skipInvalid: true }) as string;
}
