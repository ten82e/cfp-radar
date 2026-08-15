/**
 * Output generation: ICS / JSON / CSV / Markdown / llms.txt / HTML.
 *
 * Everything under public/ is produced here.  Rendering is a pure function of
 * (conferences, config, now) so that two runs with the same input are byte
 * identical.  Ported from scripts/build.py (cfp-radar).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
// 代表採択論文タイトル（R12: 会議のセマンティック/語彙プロファイル強化）。
// データパイプラインで conferences に papers として載せ、ブラウザの語彙一致と
// IDF（buildNameIdf）の両方に使えるようにする。
import { VENUE_PAPERS, venuePapersHash } from "./embeddings.ts";
import {
  addDays,
  type Conference,
  cmpStr,
  DAY_MS,
  type Deadline,
  dateOnly,
  type Edition,
  fmtDate,
  fmtUTC,
} from "./model.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// --- constants ---------------------------------------------------------------

export const KIND_LABEL_JA: Record<string, string> = {
  abstract: "概要締切",
  paper: "論文締切",
  supplementary: "補足資料締切",
  notification: "採否通知",
  camera_ready: "カメラレディ締切",
  rebuttal_start: "反論期間開始",
  rebuttal_end: "反論期間終了",
  review_release: "査読結果公開",
  registration: "登録締切",
  other: "締切",
};

export const DEFAULT_CATEGORIES: Record<string, string> = {
  hpc: "High Performance Computing",
  networking: "Networking",
  systems: "Systems",
  ai: "Artificial Intelligence / Machine Learning",
  security: "Security",
};

export const DEFAULT_SOURCES = [
  { name: "ccfddl", repo: "ccfddl/ccf-deadlines", license: "MIT" },
  { name: "aideadlines", repo: "huggingface/ai-deadlines", license: "MIT" },
  { name: "local", repo: "data/extra.yaml", license: "MIT" },
];

const ALARM_TRIGGERS = ["-P7D", "-P1D", "-PT3H"];

const CSV_COLUMNS = [
  "key",
  "title",
  "full_name",
  "categories",
  "rank_ccf",
  "rank_core",
  "year",
  "edition_id",
  "kind",
  "label",
  "round",
  "deadline_utc",
  "deadline_aoe",
  "tz_raw",
  "event_start",
  "event_end",
  "place",
  "date_text",
  "estimated",
  "sources",
  "link",
];

const TEMPLATE_MARKER = "/*__DATA__*/null";

// SPEC.md 4.1: the UID right-hand side is frozen.
export const UID_DOMAIN = "conf-deadlines.github.io";

// --- ICS primitives ----------------------------------------------------------

/** RFC 5545 TEXT escaping.  ':' is deliberately NOT escaped (breaks URLs). */
export function escapeText(value: string | null | undefined): string {
  if (!value) return "";
  let out = String(value).replace(/\\/g, "\\\\");
  out = out.replace(/;/g, "\\;").replace(/,/g, "\\,");
  out = out.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, "\\n");
  return out;
}

/** A URI property value: strip control characters, escape nothing else. */
export function uriValue(value: string | null | undefined): string {
  if (!value) return "";
  return [...String(value).trim()].filter((ch) => ch > " " && ch !== "\u007f").join("");
}

/** Fold a content line at 75 octets, never splitting a UTF-8 sequence. */
export function foldLine(line: string): string {
  const encoder = new TextEncoder();
  const raw = encoder.encode(line);
  if (raw.length <= 75) return line;
  const pieces: string[] = [];
  const decoder = new TextDecoder();
  let start = 0;
  let limit = 75; // first line: 75 octets; continuations carry a leading space
  while (start < raw.length) {
    let end = Math.min(start + limit, raw.length);
    if (end < raw.length) {
      // back off to a UTF-8 character boundary
      while (end > start && (raw[end] & 0xc0) === 0x80) end -= 1;
    }
    pieces.push(decoder.decode(raw.slice(start, end)));
    start = end;
    limit = 74;
  }
  return pieces.join("\r\n ");
}

function fmtUtc(d: Date): string {
  return fmtUTC(d, "%Y%m%dT%H%M%SZ");
}

function fmtDateIcs(d: Date): string {
  return fmtUTC(d, "%Y%m%d");
}

/**
 * タイトル + 開催年を組み立てる。タイトルが既にその年で終わっている
 * （例: `CANOPIE-HPC 2026`）場合は年を二重に付けない（#93）。
 * タイトルが別の年で終わる edition は実データに無いため、末尾一致で
 * 省くガードは必要な年を消さない。
 */
function titleWithYear(title: string, year: number): string {
  return title.trim().endsWith(String(year)) ? title.trim() : `${title.trim()} ${year}`;
}

export interface IcsEntry {
  uid: string;
  dtstamp?: Date;
  all_day?: boolean;
  start: Date;
  end: Date;
  summary: string;
  description?: string;
  url?: string;
  categories?: string[];
  alarms?: string[];
}

/**
 * Render calendar entries as an RFC 5545 stream (CRLF terminated).
 * No `METHOD` is emitted (SPEC.md 4.1).
 */
export function renderIcs(
  entries: IcsEntry[],
  options: { calname: string; caldesc: string },
): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//conf-deadlines//conf-deadlines//EN",
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${escapeText(options.calname)}`,
    `X-WR-CALDESC:${escapeText(options.caldesc)}`,
    "X-WR-TIMEZONE:UTC",
    "REFRESH-INTERVAL;VALUE=DURATION:PT12H",
    "X-PUBLISHED-TTL:PT12H",
  ];
  for (const entry of entries) {
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${escapeText(entry.uid)}`);
    lines.push(`DTSTAMP:${fmtUtc(entry.dtstamp ?? new Date(0))}`);
    if (entry.all_day) {
      lines.push(`DTSTART;VALUE=DATE:${fmtDateIcs(entry.start)}`);
      // RFC 5545: DTEND is exclusive for DATE values
      lines.push(`DTEND;VALUE=DATE:${fmtDateIcs(addDays(entry.end, 1))}`);
    } else {
      lines.push(`DTSTART:${fmtUtc(entry.start)}`);
      lines.push(`DTEND:${fmtUtc(entry.end)}`);
    }
    lines.push(`SUMMARY:${escapeText(entry.summary)}`);
    if (entry.description) {
      lines.push(`DESCRIPTION:${escapeText(entry.description)}`);
    }
    if (entry.url) {
      lines.push(`URL:${uriValue(entry.url)}`);
    }
    if (entry.categories && entry.categories.length > 0) {
      lines.push(`CATEGORIES:${entry.categories.map((c) => escapeText(c)).join(",")}`);
    }
    for (const trigger of entry.alarms ?? []) {
      lines.push("BEGIN:VALARM");
      lines.push("ACTION:DISPLAY");
      lines.push(`DESCRIPTION:${escapeText(entry.summary)}`);
      lines.push(`TRIGGER:${trigger}`);
      lines.push("END:VALARM");
    }
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map((line) => `${foldLine(line)}\r\n`).join("");
}

/**
 * 既存 embeddings.json と現在の会議キー集合から再生成要否を判定する。
 * キー**数**だけでなく集合自体の一致を比較する（数比較だと同数の
 * 入れ替え・改名で stale のまま残り、新規会議が semanticScore 0 になる）。
 * R29 の VENUE_PAPERS ハッシュ比較も引き継ぐ。
 */
export function embeddingsStale(
  existing: { embeddings?: Record<string, unknown>; venuePapersHash?: string },
  confKeys: string[],
): boolean {
  const have = new Set(Object.keys(existing.embeddings ?? {}));
  const want = new Set(confKeys);
  if (existing.venuePapersHash !== venuePapersHash()) return true;
  if (have.size !== want.size) return true;
  for (const key of want) {
    if (!have.has(key)) return true;
  }
  return false;
}

// --- record extraction -------------------------------------------------------

/** Anywhere on Earth display: UTC-12 wall clock of `atUtc`. */
function aoeText(atUtc: Date): string {
  return `${fmtUTC(addDays(atUtc, -0.5), "%Y-%m-%d %H:%M:%S")} AoE`;
}

function rankText(rank: Record<string, string>): string {
  return Object.entries(rank)
    .filter(([, v]) => v)
    .sort(([a], [b]) => cmpStr(a, b))
    .map(([k, v]) => `${k.toUpperCase()} ${v}`)
    .join(", ");
}

function sortedDeadlines(edition: Edition): Deadline[] {
  return [...edition.deadlines].sort(
    (a, b) =>
      a.round - b.round ||
      a.at_utc.getTime() - b.at_utc.getTime() ||
      cmpStr(a.kind, b.kind) ||
      cmpStr(a.label ?? "", b.label ?? ""),
  );
}

/**
 * Number deadlines 1.. within each (year, kind), ordered by `at_utc`
 * (SPEC.md 4.1).
 */
function deadlineOrdinals(editions: Edition[]): Map<number, Map<number, number>> {
  const groups = new Map<
    string,
    Array<{ at: Date; editionId: string; round: number; label: string; i: number; j: number }>
  >();
  editions.forEach((ed, i) => {
    sortedDeadlines(ed).forEach((dl, j) => {
      const key = `${ed.year}\u0000${dl.kind}`;
      const list = groups.get(key) ?? [];
      list.push({
        at: dl.at_utc,
        editionId: ed.edition_id,
        round: dl.round,
        label: dl.label ?? "",
        i,
        j,
      });
      groups.set(key, list);
    });
  });
  const out = new Map<number, Map<number, number>>();
  for (const items of groups.values()) {
    const sorted = [...items].sort(
      (a, b) =>
        a.at.getTime() - b.at.getTime() ||
        cmpStr(a.editionId, b.editionId) ||
        a.round - b.round ||
        cmpStr(a.label, b.label) ||
        a.i - b.i ||
        a.j - b.j,
    );
    sorted.forEach((item, n) => {
      const perEdition = out.get(item.i) ?? new Map<number, number>();
      perEdition.set(item.j, n + 1);
      out.set(item.i, perEdition);
    });
  }
  return out;
}

/** Number the meetings of one (key, year) by `event_start` (SPEC.md 4.1). */
function eventOrdinals(editions: Edition[]): Map<number, number> {
  const groups = new Map<number, Array<{ start: Date; editionId: string; i: number }>>();
  editions.forEach((ed, i) => {
    if (ed.event_start) {
      const list = groups.get(ed.year) ?? [];
      list.push({ start: ed.event_start, editionId: ed.edition_id, i });
      groups.set(ed.year, list);
    }
  });
  const out = new Map<number, number>();
  for (const items of groups.values()) {
    const sorted = [...items].sort(
      (a, b) =>
        a.start.getTime() - b.start.getTime() || cmpStr(a.editionId, b.editionId) || a.i - b.i,
    );
    sorted.forEach((item, n) => {
      out.set(item.i, n + 1);
    });
  }
  return out;
}

/** `(year, kind, at_utc)` groups holding more than one deadline. */
function collisions(editions: Edition[]): Set<string> {
  const seen = new Map<string, number>();
  for (const ed of editions) {
    for (const dl of ed.deadlines) {
      const key = `${ed.year}\u0000${dl.kind}\u0000${dl.at_utc.getTime()}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
  }
  const out = new Set<string>();
  for (const [key, count] of seen) {
    if (count > 1) out.add(key);
  }
  return out;
}

function eventSuffix(ordinal: number): string {
  return ordinal === 1 ? "" : `-${ordinal}`;
}

export interface CalendarRecord {
  type: "deadline" | "event";
  categories: string[];
  kind_label: string;
  estimated: boolean;
  conf: Conference;
  edition: Edition;
  deadline: Deadline | null;
  entry: IcsEntry;
}

/** Flatten conferences into calendar records (entry + routing metadata). */
export function recordsOf(confs: Conference[]): CalendarRecord[] {
  const records: CalendarRecord[] = [];
  const usedUids = new Map<string, number>();

  const uid = (base: string): string => {
    const n = (usedUids.get(base) ?? 0) + 1;
    usedUids.set(base, n);
    if (n === 1) return base;
    const at = base.indexOf("@");
    const local = at >= 0 ? base.slice(0, at) : base;
    const dom = at >= 0 ? base.slice(at) : "";
    return `${local}-${n}${dom}`;
  };

  for (const conf of [...confs].sort((a, b) => cmpStr(a.key, b.key))) {
    const cats = [...conf.categories];
    const rank = rankText(conf.rank);
    const editions = [...conf.editions].sort(
      (a, b) => a.year - b.year || cmpStr(a.edition_id, b.edition_id),
    );
    const ordinals = deadlineOrdinals(editions);
    const eventOrds = eventOrdinals(editions);
    const collides = collisions(editions);
    editions.forEach((ed, edIndex) => {
      const link = ed.link || conf.link;
      sortedDeadlines(ed).forEach((dl, dlIndex) => {
        let labelJa = KIND_LABEL_JA[dl.kind] ?? KIND_LABEL_JA.other;
        if (collides.has(`${ed.year}\u0000${dl.kind}\u0000${dl.at_utc.getTime()}`) && dl.label) {
          labelJa = `${labelJa}: ${dl.label}`;
        }
        const desc = [
          conf.full_name || conf.title,
          `${dl.label || labelJa}: ${aoeText(dl.at_utc)} / ${fmtUTC(dl.at_utc, "%Y-%m-%d %H:%M:%S")} UTC (元表記 ${dl.tz_raw || "UTC"})`,
          `ラウンド: ${dl.round}`,
        ];
        if (rank) desc.push(`ランク: ${rank}`);
        if (ed.place) desc.push(`開催地: ${ed.place}`);
        if (ed.date_text) desc.push(`会期: ${ed.date_text}`);
        if (link) desc.push(`リンク: ${link}`);
        if (dl.comment) desc.push(`備考: ${dl.comment}`);
        if (ed.estimated) desc.push("※ 推定日程（上流に未掲載のため過去実績から算出）");
        desc.push(`出典: ${ed.source || conf.sources.join(",")}`);
        const ord = ordinals.get(edIndex)?.get(dlIndex) ?? 1;
        records.push({
          type: "deadline",
          categories: cats,
          kind_label: labelJa,
          estimated: ed.estimated,
          conf,
          edition: ed,
          deadline: dl,
          entry: {
            uid: uid(`${conf.key}-${ed.year}-${dl.kind}-${ord}@${UID_DOMAIN}`),
            summary: `${titleWithYear(conf.title, ed.year)} ${labelJa}${ed.estimated ? "（推定）" : ""}`,
            description: desc.join("\n"),
            url: link,
            categories: [...cats, dl.kind],
            all_day: false,
            start: new Date(dl.at_utc.getTime() - 30 * 60_000),
            end: dl.at_utc,
            alarms: [...ALARM_TRIGGERS],
          },
        });
      });
      if (ed.event_start && !ed.estimated) {
        const desc = [conf.full_name || conf.title];
        if (ed.date_text) desc.push(`会期: ${ed.date_text}`);
        if (ed.place) desc.push(`開催地: ${ed.place}`);
        if (rank) desc.push(`ランク: ${rank}`);
        if (link) desc.push(`リンク: ${link}`);
        desc.push(`出典: ${ed.source || conf.sources.join(",")}`);
        records.push({
          type: "event",
          categories: cats,
          kind_label: "開催",
          estimated: false,
          conf,
          edition: ed,
          deadline: null,
          entry: {
            uid: uid(
              `${conf.key}-${ed.year}-event${eventSuffix(eventOrds.get(edIndex) ?? 1)}@${UID_DOMAIN}`,
            ),
            summary: titleWithYear(conf.title, ed.year),
            description: desc.join("\n"),
            url: link,
            categories: [...cats, "event"],
            all_day: true,
            start: ed.event_start,
            end: ed.event_end ?? ed.event_start,
            alarms: [],
          },
        });
      }
    });
  }
  return records;
}

function sortKey(rec: CalendarRecord): [number, string] {
  const start = rec.entry.start;
  // Python: all_day はその日の 00:00 UTC、それ以外は正確な時刻で stamp。
  const stamp = rec.entry.all_day ? dateOnly(start).getTime() : start.getTime();
  return [stamp, rec.entry.uid];
}

// --- serialisation -----------------------------------------------------------

export function toJson(
  confs: Conference[],
  config: Record<string, unknown>,
  now: Date,
): Record<string, unknown> {
  const site = (config.site as Record<string, unknown>) ?? {};
  const domain = String(site.domain ?? "conf-deadlines");
  const baseUrl = String(site.base_url ?? `https://${domain}`).replace(/\/+$/, "");
  const categories = (config.categories as Record<string, string> | null) ?? DEFAULT_CATEGORIES;
  const sources = (config.sources as Array<Record<string, unknown>> | null) ?? DEFAULT_SOURCES;
  const outConfs: unknown[] = [];
  for (const conf of [...confs].sort((a, b) => cmpStr(a.key, b.key))) {
    const editions: unknown[] = [];
    for (const ed of [...conf.editions].sort(
      (a, b) => a.year - b.year || cmpStr(a.edition_id, b.edition_id),
    )) {
      editions.push({
        year: ed.year,
        id: ed.edition_id,
        link: ed.link || conf.link,
        place: ed.place,
        date_text: ed.date_text,
        event_start: ed.event_start ? fmtDate(ed.event_start) : null,
        event_end: ed.event_end ? fmtDate(ed.event_end) : null,
        estimated: ed.estimated,
        source: ed.source,
        deadlines: sortedDeadlines(ed).map((dl) => ({
          kind: dl.kind,
          label: dl.label,
          utc: fmtUTC(dl.at_utc, "%Y-%m-%dT%H:%M:%SZ"),
          aoe: aoeText(dl.at_utc),
          tz_raw: dl.tz_raw,
          round: dl.round,
          comment: dl.comment,
        })),
      });
    }
    outConfs.push({
      key: conf.key,
      title: conf.title,
      full_name: conf.full_name,
      categories: [...conf.categories],
      rank: { ...conf.rank },
      link: conf.link,
      tags: [...conf.tags],
      sources: [...conf.sources],
      editions,
      // 代表採択論文タイトル（無い会議は空配列）— 語彙一致 + IDF + 埋め込み強化に使う
      papers: VENUE_PAPERS[conf.key] ?? [],
    });
  }
  return {
    generated_at: fmtUTC(now, "%Y-%m-%dT%H:%M:%SZ"),
    site: {
      domain,
      base_url: baseUrl,
    },
    sources,
    categories: { ...categories },
    conferences: outConfs,
  };
}

export function csvField(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(records: CalendarRecord[]): string {
  const lines: string[] = [];
  lines.push(CSV_COLUMNS.join(","));
  for (const rec of records) {
    if (rec.type !== "deadline") continue;
    const { conf, edition: ed, deadline: dl } = rec;
    if (dl === null) continue;
    lines.push(
      [
        conf.key,
        conf.title,
        conf.full_name,
        conf.categories.join(";"),
        conf.rank.ccf ?? "",
        conf.rank.core ?? "",
        ed.year,
        ed.edition_id,
        dl.kind,
        dl.label ?? "",
        dl.round,
        fmtUTC(dl.at_utc, "%Y-%m-%dT%H:%M:%SZ"),
        aoeText(dl.at_utc),
        dl.tz_raw ?? "",
        ed.event_start ? fmtDate(ed.event_start) : "",
        ed.event_end ? fmtDate(ed.event_end) : "",
        ed.place ?? "",
        ed.date_text ?? "",
        ed.estimated ? "true" : "false",
        conf.sources.join(";"),
        ed.link || conf.link || "",
      ]
        .map((v) => csvField(v))
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

export function toUpcomingMd(records: CalendarRecord[], now: Date, days = 180): string {
  const horizon = addDays(now, days);
  const today = dateOnly(now);
  const rows: string[] = [];
  for (const rec of records) {
    const { conf, edition: ed } = rec;
    const link = ed.link || conf.link;
    const name = link
      ? `[${titleWithYear(conf.title, ed.year)}](${link})`
      : titleWithYear(conf.title, ed.year);
    if (rec.type === "deadline") {
      const dl = rec.deadline;
      if (dl === null) continue;
      if (now.getTime() > dl.at_utc.getTime() || dl.at_utc.getTime() > horizon.getTime()) continue;
      const remainMs = dl.at_utc.getTime() - now.getTime();
      const remainDays = Math.floor(remainMs / DAY_MS);
      let left: string;
      if (remainDays >= 1) {
        left = `${remainDays}日`;
      } else {
        const hours = Math.floor(remainMs / 3_600_000);
        if (hours >= 1) {
          left = `${hours}時間`;
        } else {
          const mins = Math.max(1, Math.floor(remainMs / 60_000));
          left = `${mins}分`;
        }
      }
      const when = aoeText(dl.at_utc);
      const kindText = rec.kind_label;
      const roundText = `R${dl.round}`;
      rows.push(
        `| ${when} | ${left} | ${name} | ${kindText} | ${roundText} | ${ed.estimated ? "推定" : ""} | ${ed.place ?? ""} |`,
      );
    } else {
      const start = ed.event_start;
      if (start === null) continue;
      const end = ed.event_end ?? start;
      if (
        dateOnly(start).getTime() > dateOnly(horizon).getTime() ||
        today.getTime() > dateOnly(end).getTime()
      ) {
        continue;
      }
      let left: string;
      const startDay = dateOnly(start).getTime();
      const endDay = dateOnly(end).getTime();
      if (today.getTime() < startDay) {
        left = `${(startDay - today.getTime()) / DAY_MS}日`;
      } else if (today.getTime() === startDay) {
        left = "本日開催";
      } else {
        left = `開催中(残り${(endDay - today.getTime()) / DAY_MS + 1}日)`;
      }
      const when =
        end.getTime() !== start.getTime() ? `${fmtDate(start)} 〜 ${fmtDate(end)}` : fmtDate(start);
      rows.push(
        `| ${when} | ${left} | ${name} | 開催 | - | ${ed.estimated ? "推定" : ""} | ${ed.place ?? ""} |`,
      );
    }
  }
  const head = [
    `# 直近 ${days} 日の締切と開催`,
    "",
    `生成時刻: ${fmtUTC(now, "%Y-%m-%dT%H:%M:%SZ")}`,
    "",
    "| 日付 | 残り | 会議 | 種別 | R | 推定 | 開催地 |",
    "|---|---|---|---|---|---|---|",
  ];
  if (rows.length === 0) rows.push("| - | - | 該当なし | - | - | - | - |");
  return `${[...head, ...rows].join("\n")}\n`;
}

export function toLlmsTxt(
  baseUrl: string,
  feeds: Array<[string, string]>,
  config: Record<string, unknown>,
): string {
  const categories = (config.categories as Record<string, string> | null) ?? DEFAULT_CATEGORIES;
  const sources = (config.sources as Array<Record<string, unknown>> | null) ?? DEFAULT_SOURCES;
  const lines = [
    "# conf-deadlines",
    "",
    "HPC・ネットワーク・システム・AI 系の国際会議の投稿締切と開催日を、",
    "上流の公開データから日次で正規化して配信する静的フィード集である。",
    "サーバは無く、GitHub Pages 上の静的ファイルだけで構成される。",
    "",
    "## 更新頻度",
    "",
    "毎日 20:17 UTC（05:17 JST）に GitHub Actions が上流を取得して再生成する。",
    "各 ICS は REFRESH-INTERVAL / X-PUBLISHED-TTL に PT12H を宣言している。",
    "",
    "## フィード一覧（絶対 URL）",
    "",
  ];
  for (const [name, meaning] of feeds) {
    lines.push(`- ${baseUrl}/${name} — ${meaning}`);
  }
  lines.push(
    "",
    "## data.json のスキーマ要約",
    "",
    "トップレベルは以下のキーを持つオブジェクトである。",
    "",
    "- generated_at: string — 生成時刻。'YYYY-MM-DDTHH:MM:SSZ'（UTC）。",
    "- sources: array of {name, repo, license} — 出典と授権。",
    "- categories: object — カテゴリ ID から英語名への写像。",
    `  実在値: ${[...Object.keys(categories)].sort().join(", ")}。`,
    "- conferences: array — 会議の配列。各要素は次の形である。",
    "  - key: string — 正規化キー（slug）。例 'sigcomm'。",
    "  - title: string — 略称。例 'SIGCOMM'。",
    "  - full_name: string — 正式名称。",
    "  - categories: array of string — 上記 categories のキー。",
    "  - rank: object — {'ccf': 'A', 'core': 'A*'} 等。欠けうる。",
    "    値 'N' は上流でランクが付いていないことを表す番兵であり、等級ではない。",
    "  - link: string — 会議の公式サイト。",
    "  - tags: array of string — 補助タグ。カテゴリではない。",
    "  - sources: array of string — この会議の出典名。",
    "  - editions: array — 開催回。各要素は次の形である。",
    "    - year: integer, id: string（例 'sigcomm26'）, link: string, place: string",
    "    - date_text: string — 上流の自由文の会期表記。構造化されていないことがある。",
    "    - event_start / event_end: string|null — 'YYYY-MM-DD'。パース不能なら null。",
    "    - estimated: boolean — true は過去実績からの推定。実データではない。",
    "    - source: string — この開催回を提供した出典名。",
    "    - deadlines: array — 各要素は次の形である。",
    "      - kind: string — 'abstract'|'paper'|'supplementary'|'notification'" +
      "|'camera_ready'|'rebuttal_start'|'rebuttal_end'|'review_release'" +
      "|'registration'|'other' の 10 種のみ。",
    "      - label: string — 上流の表示用ラベル。",
    "      - utc: string — 'YYYY-MM-DDTHH:MM:SSZ'。比較・整列にはこれを使う。",
    "      - aoe: string — 'YYYY-MM-DD HH:MM:SS AoE'（UTC-12 での表記）。",
    "      - tz_raw: string — 上流の元タイムゾーン表記。",
    "      - round: integer — 1 起点。複数投稿ラウンドを持つ会議がある。",
    "      - comment: string|null — 上流の注記。",
    "",
    "## 利用上の注意",
    "",
    "- 締切の比較は必ず deadlines[].utc で行う。aoe は表示用である。",
    "- estimated=true の版は推定であり、all.ics と分野別 ICS には含まれない。" +
      "推定は all-estimated.ics と <カテゴリ>-estimated.ics にのみ出る。",
    "- data.csv は 1 行 1 締切のフラット表で、data.json の部分集合である。",
    "  comment・tags・thcpl ランクは列に無い。全情報が要るときは data.json を使う。",
    "- 権威は上流と各会議の公式サイトである。重要な判断の前に link 先を確認すること。",
    "",
    "## 出典とライセンス",
    "",
  );
  for (const src of sources) {
    lines.push(`- ${src.name}: ${src.repo} （${src.license}）`);
  }
  lines.push(
    "",
    "本リポジトリの生成物は MIT ライセンスで配布する。",
    "上流データの権利は各上流リポジトリに帰属し、NOTICE.md に帰属表示がある。",
    "",
  );
  return lines.join("\n");
}

/** Python json.dumps(obj, ensure_ascii=False) 互換のコンパクト直列化。 */
function pyJsonCompact(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return `[${value.map(pyJsonCompact).join(", ")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}: ${pyJsonCompact(v)}`).join(", ")}}`;
}

/** Make a JSON literal safe to paste into a <script> body. */
function embedJson(jsJson: string): string {
  return jsJson
    .replace(/<\//g, "<\\/")
    .replace(/<!--/g, "\\u003c!--")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

// --- entry point -------------------------------------------------------------

export interface BuildStats {
  generated_at: string;
  conferences: number;
  editions: number;
  deadlines: number;
  events: number;
  estimated: number;
  files: string[];
  merged?: number;
}

/** Generate everything under `outdir` and return a stats dict. */
export async function buildAll(
  confs: Conference[],
  config: Record<string, unknown>,
  outdir: string,
  now: Date,
  opts: { noEmbeddings?: boolean } = {},
): Promise<BuildStats> {
  mkdirSync(outdir, { recursive: true });

  const nowUtc = new Date(now.getTime());
  // DTSTAMP is derived from --now (floored to the day).
  const dtstamp = new Date(
    Date.UTC(nowUtc.getUTCFullYear(), nowUtc.getUTCMonth(), nowUtc.getUTCDate()),
  );

  const site = (config.site as Record<string, unknown>) ?? {};
  const domain = String(site.domain ?? "conf-deadlines");
  const baseUrl = String(site.base_url ?? `https://${domain}`).replace(/\/+$/, "");
  // config.yaml の site.upcoming_days（既定 180）: upcoming.md の窓を決める。
  // これまで宣言のみで読まれず 180 に固定されていた（#95）。
  const upcomingDays = Number(site.upcoming_days ?? 180) || 180;
  const categories = (config.categories as Record<string, string> | null) ?? DEFAULT_CATEGORIES;

  const records = recordsOf(confs);
  records.sort((a, b) => {
    const [sa, sb] = [sortKey(a), sortKey(b)];
    return sa[0] - sb[0] || cmpStr(sa[1], sb[1]);
  });
  for (const rec of records) {
    rec.entry.dtstamp = dtstamp;
  }

  const live = (r: CalendarRecord): boolean => !r.estimated;
  const feeds: Array<[string, string, string, IcsEntry[]]> = [
    [
      "all.ics",
      "会議締切・開催日（全カテゴリ）",
      "全カテゴリ・全種別の締切と開催日。推定は含まない。",
      records.filter(live).map((r) => r.entry),
    ],
  ];
  for (const cat of Object.keys(categories).sort()) {
    feeds.push([
      `${cat}.ics`,
      `会議締切・開催日（${categories[cat] ?? cat}）`,
      `カテゴリ ${cat} の締切と開催日。推定は含まない。`,
      records.filter((r) => live(r) && r.categories.includes(cat)).map((r) => r.entry),
    ]);
  }
  feeds.push([
    "deadlines.ics",
    "会議締切のみ",
    "投稿・通知などの締切のみ。開催日は含まない。",
    records.filter((r) => live(r) && r.type === "deadline").map((r) => r.entry),
  ]);
  // 開催日のみの終日イベント（README / SPEC の events.ics 契約）。イベントは
  // recordsOf が非推定版の event_start からしか作らないため推定判定は不要。
  feeds.push([
    "events.ics",
    "会議開催日のみ",
    "会期の終日イベントのみ。締切は含まない。",
    records.filter((r) => r.type === "event").map((r) => r.entry),
  ]);
  const est = (r: CalendarRecord): boolean => r.estimated && r.type === "deadline";
  feeds.push([
    "all-estimated.ics",
    "推定締切（全カテゴリ・未確定）",
    "上流に未掲載のため過去実績から推定した締切。確定情報ではない。",
    records.filter(est).map((r) => r.entry),
  ]);
  for (const cat of Object.keys(categories).sort()) {
    feeds.push([
      `${cat}-estimated.ics`,
      `推定締切（${categories[cat] ?? cat}・未確定）`,
      `カテゴリ ${cat} の推定締切のみ。確定情報ではない。`,
      records.filter((r) => est(r) && r.categories.includes(cat)).map((r) => r.entry),
    ]);
  }

  const written: string[] = [];

  const write = (name: string, text: string): void => {
    writeFileSync(join(outdir, name), text, "utf8");
    written.push(name);
  };

  for (const [name, calname, caldesc, ents] of feeds) {
    write(name, renderIcs(ents, { calname, caldesc }));
  }

  const data = toJson(confs, config, nowUtc);
  const jsonText = JSON.stringify(data, null, 2);
  write("data.json", `${jsonText}\n`);
  write("data.csv", toCsv(records));
  write("upcoming.md", toUpcomingMd(records, nowUtc, upcomingDays));

  // セマンティックレコメンド用の埋め込み（transformers.js が無ければスキップして語彙のみで動作）
  if (!opts.noEmbeddings) {
    try {
      const embPath = join(outdir, "embeddings.json");
      let needEmb = true;
      try {
        const existing = JSON.parse(readFileSync(embPath, "utf8")) as {
          embeddings?: Record<string, unknown>;
        };
        needEmb = embeddingsStale(
          existing,
          confs.map((c) => c.key),
        );
      } catch {
        needEmb = true;
      }
      if (needEmb) {
        const { buildEmbeddings } = await import("./embeddings.ts");
        await buildEmbeddings(join(outdir, "data.json"), embPath);
        written.push("embeddings.json");
      }
    } catch (exc) {
      console.warn(
        `warning: embeddings を生成しなかった（${(exc as Error).constructor.name}: ${String(exc)}）`,
      );
    }
  }

  write(
    "llms.txt",
    toLlmsTxt(
      baseUrl,
      [
        ...feeds.map((f) => [f[0], f[2]] as [string, string]),
        ["data.json", "正規化データ全体（機械可読の正）"],
        ["data.csv", "1 行 1 締切のフラット表"],
        ["upcoming.md", `直近 ${upcomingDays} 日の締切と開催の表`],
      ],
      config,
    ),
  );
  write(".nojekyll", "");

  const template = String(config.template ?? "site/template.html");
  const templatePath = isAbsolute(template) ? template : join(ROOT, template);
  let templateText: string | null = null;
  try {
    templateText = readFileSync(templatePath, "utf8");
  } catch {
    templateText = null;
  }
  if (templateText !== null) {
    if (!templateText.includes(TEMPLATE_MARKER)) {
      console.warn(
        `warning: ${templatePath} に ${TEMPLATE_MARKER} が見つからない。index.html を素通しする`,
      );
    } else {
      templateText = templateText.replace(TEMPLATE_MARKER, embedJson(pyJsonCompact(data)));
    }
    write("index.html", templateText);
    // recommender.js をテンプレートと同じ場所から同梱（ブラウザから src 参照）
    const rec = join(dirname(templatePath), "recommender.js");
    try {
      write("recommender.js", readFileSync(rec, "utf8"));
    } catch {
      console.warn(`warning: ${rec} が無い。index.html の src 参照が 404 になる`);
    }
  } else {
    console.warn(`warning: ${templatePath} が無いので index.html を生成しない`);
  }

  const nDeadlines = records.filter((r) => r.type === "deadline").length;
  return {
    generated_at: String(data.generated_at),
    conferences: confs.length,
    editions: confs.reduce((n, c) => n + c.editions.length, 0),
    deadlines: nDeadlines,
    events: records.length - nDeadlines,
    estimated: records.filter((r) => r.estimated).length,
    files: written,
  };
}

export { ROOT };
