/**
 * Output generation: JSON / CSV / Markdown / llms.txt / HTML.
 *
 * Everything under public/ is produced here.  Rendering is a pure function of
 * (conferences, config, now) so that two runs with the same input are byte
 * identical.  Ported from scripts/build.py (kamiyobi).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
// 代表採択論文タイトル（R12: 会議のセマンティック/語彙プロファイル強化）。
// データパイプラインで conferences に papers として載せ、ブラウザの語彙一致と
// IDF（buildNameIdf）の両方に使えるようにする。
import {
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
  EMBEDDING_MULTI_MODEL,
  EMBEDDING_REVISION,
  embeddingManifest,
  embeddingProfileHash,
  VENUE_PAPERS,
  venuePapersHash,
} from "./embeddings.ts";
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

export let ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function setRoot(root: string): void {
  ROOT = root;
}

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
  systems: "Systems, Architecture and Storage",
  ai: "AI and Machine Learning",
  security: "Security and Privacy",
  db: "Database and Data Mining",
  graphics: "Graphics and Multimedia",
  hci: "Human-Computer Interaction",
  theory: "Theory and Algorithms",
};

export const DEFAULT_SOURCES = [
  { name: "ccfddl", repo: "ccfddl/ccf-deadlines", license: "MIT" },
  { name: "aideadlines", repo: "huggingface/ai-deadlines", license: "MIT" },
  { name: "local", repo: "data/extra.yaml", license: "MIT" },
];

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
  "estimate_window_start",
  "estimate_window_end",
  "sources",
  "link",
];

const TEMPLATE_MARKER = "/*__DATA__*/null";

/**
 * タイトル + 開催年を組み立てる。タイトルが既にその年（例: `CANOPIE-HPC 2026`）
 * または短縮年（例: `SC '26`, `SC ’26`）で終わっている場合は年を二重に付けない（#93, #276）。
 * year が 0 / 未指定の場合はタイトルのみを返す。
 */
export function titleWithYear(
  title: string | null | undefined,
  year: number | null | undefined,
): string {
  const t = String(title ?? "").trim();
  if (!t) return "";
  if (!year) return t;
  const yStr = String(year);
  const yy = yStr.slice(-2);
  const normT = t.normalize("NFKC").trim();
  const hasYear =
    normT.endsWith(yStr) ||
    normT.endsWith(`'${yy}`) ||
    (yy && new RegExp(`(?:20${yy}|['’]?${yy})$`).test(normT));
  if (hasYear) {
    return t;
  }
  return `${t} ${year}`;
}

type EmbeddingFile = {
  model?: unknown;
  dim?: unknown;
  venuePapersHash?: unknown;
  embeddings?: Record<string, unknown>;
  multi?: { model?: unknown; dim?: unknown; embeddings?: Record<string, unknown> };
  paperVecs?: Record<string, unknown>;
  manifest?: {
    schema?: unknown;
    profile_hash?: unknown;
    keys?: unknown;
    venue_papers_hash?: unknown;
    models?: {
      en?: { model?: unknown; revision?: unknown; dim?: unknown; probe?: { vector?: unknown } };
      multi?: { model?: unknown; revision?: unknown; dim?: unknown; probe?: { vector?: unknown } };
    };
    paper_vecs?: { keys?: unknown; dim?: unknown };
  };
};

function sameKeys(have: Record<string, unknown> | undefined, want: string[]): boolean {
  const keys = Object.keys(have ?? {}).sort();
  return keys.length === want.length && keys.every((key, i) => key === want[i]);
}

function vectorsHaveDim(vectors: Record<string, unknown> | undefined, dim: number): boolean {
  return Object.values(vectors ?? {}).every(
    (vector) => Array.isArray(vector) && vector.length === dim,
  );
}

/** 既存 embeddings.json が profile/model/vector 契約を満たすか判定する。 */
export function embeddingsStale(
  existing: EmbeddingFile | null | undefined,
  data: Parameters<typeof embeddingProfileHash>[0],
): boolean {
  if (!existing || typeof existing !== "object") return true;
  const expected = embeddingManifest(data);
  const manifest = existing.manifest;
  const en = manifest?.models?.en;
  const multi = manifest?.models?.multi;
  if (!manifest || !en || !multi) return true;
  if (manifest.schema !== expected.schema || manifest.profile_hash !== expected.profile_hash)
    return true;
  if (manifest.profile_hash !== embeddingProfileHash(data)) return true;
  if (
    !sameKeys(existing.embeddings, expected.keys) ||
    !sameKeys(existing.multi?.embeddings, expected.keys)
  ) {
    return true;
  }
  if (JSON.stringify(manifest.keys) !== JSON.stringify(expected.keys)) return true;
  if (manifest.venue_papers_hash !== expected.venue_papers_hash) return true;
  if (existing.venuePapersHash !== venuePapersHash()) return true;
  if (
    existing.model !== EMBEDDING_MODEL ||
    existing.dim !== EMBEDDING_DIM ||
    existing.multi?.model !== EMBEDDING_MULTI_MODEL ||
    existing.multi?.dim !== EMBEDDING_DIM
  ) {
    return true;
  }
  if (
    en.model !== EMBEDDING_MODEL ||
    en.revision !== EMBEDDING_REVISION ||
    en.dim !== EMBEDDING_DIM ||
    multi.model !== EMBEDDING_MULTI_MODEL ||
    multi.revision !== EMBEDDING_REVISION ||
    multi.dim !== EMBEDDING_DIM ||
    !Array.isArray(en.probe?.vector) ||
    en.probe.vector.length !== EMBEDDING_DIM ||
    !Array.isArray(multi.probe?.vector) ||
    multi.probe.vector.length !== EMBEDDING_DIM
  ) {
    return true;
  }
  if (!vectorsHaveDim(existing.embeddings, EMBEDDING_DIM)) return true;
  if (!vectorsHaveDim(existing.multi?.embeddings, EMBEDDING_DIM)) return true;
  if (!vectorsHaveDim(existing.paperVecs, EMBEDDING_DIM)) return true;
  if (JSON.stringify(manifest.paper_vecs?.keys) !== JSON.stringify(expected.paper_vecs.keys))
    return true;
  if (manifest.paper_vecs?.dim !== EMBEDDING_DIM) return true;
  return false;
}

// --- record extraction -------------------------------------------------------

/** Anywhere on Earth display: UTC-12 wall clock of `atUtc`. */
function aoeText(atUtc: Date): string {
  return `${fmtUTC(addDays(atUtc, -0.5), "%Y-%m-%d %H:%M:%S")} AoE`;
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

export interface DataRecord {
  type: "deadline" | "event";
  categories: string[];
  kind_label: string;
  estimated: boolean;
  conf: Conference;
  edition: Edition;
  deadline: Deadline | null;
  all_day: boolean;
  start: Date;
  end: Date;
}

/** Flatten conferences into rows for CSV and upcoming.md. */
export function recordsOf(confs: Conference[] | null | undefined): DataRecord[] {
  if (!confs || !Array.isArray(confs)) return [];
  const records: DataRecord[] = [];
  for (const conf of [...confs].sort((a, b) => cmpStr(a?.key ?? "", b?.key ?? ""))) {
    if (!conf || typeof conf !== "object") continue;
    const cats = Array.isArray(conf.categories) ? [...conf.categories] : [];
    const editions = (Array.isArray(conf.editions) ? [...conf.editions] : [])
      .filter((e) => e && typeof e === "object")
      .sort(
        (a, b) => (a.year ?? 0) - (b.year ?? 0) || cmpStr(a.edition_id ?? "", b.edition_id ?? ""),
      );
    const collides = collisions(editions);
    editions.forEach((ed) => {
      sortedDeadlines(ed).forEach((dl) => {
        let labelJa = KIND_LABEL_JA[dl.kind] ?? KIND_LABEL_JA.other;
        if (collides.has(`${ed.year}\u0000${dl.kind}\u0000${dl.at_utc.getTime()}`) && dl.label) {
          labelJa = `${labelJa}: ${dl.label}`;
        }
        records.push({
          type: "deadline",
          categories: cats,
          kind_label: labelJa,
          estimated: ed.estimated,
          conf,
          edition: ed,
          deadline: dl,
          all_day: false,
          start: new Date(dl.at_utc.getTime() - 30 * 60_000),
          end: dl.at_utc,
        });
      });
      if (ed.event_start && !ed.estimated) {
        records.push({
          type: "event",
          categories: cats,
          kind_label: "開催",
          estimated: false,
          conf,
          edition: ed,
          deadline: null,
          all_day: true,
          start: ed.event_start,
          end: ed.event_end ?? ed.event_start,
        });
      }
    });
  }
  return records;
}

function sortKey(rec: DataRecord): [number, string] {
  // Python: all_day はその日の 00:00 UTC、それ以外は正確な時刻で stamp。
  const stamp = rec.all_day ? dateOnly(rec.start).getTime() : rec.start.getTime();
  return [stamp, `${rec.conf.key}:${rec.deadline?.kind ?? "event"}:${rec.start.getTime()}`];
}

// --- serialisation -----------------------------------------------------------

export function toJson(
  confs: Conference[] | null | undefined,
  config: Record<string, unknown> | null | undefined,
  now: Date | null | undefined,
): Record<string, unknown> {
  const safeNow = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const safeConfig = config ?? {};
  const site = (safeConfig.site as Record<string, unknown>) ?? {};
  const domain = String(site.domain ?? "conf-deadlines");
  const baseUrl = String(site.base_url ?? `https://${domain}`).replace(/\/+$/, "");
  const categories = (safeConfig.categories as Record<string, string> | null) ?? DEFAULT_CATEGORIES;
  const sources = (safeConfig.sources as Array<Record<string, unknown>> | null) ?? DEFAULT_SOURCES;
  const outConfs: unknown[] = [];
  for (const conf of [...(confs ?? [])].sort((a, b) => cmpStr(a?.key ?? "", b?.key ?? ""))) {
    if (!conf || typeof conf !== "object") continue;
    const editions: unknown[] = [];
    for (const ed of [...(conf.editions ?? [])].sort(
      (a, b) => (a.year ?? 0) - (b.year ?? 0) || cmpStr(a.edition_id ?? "", b.edition_id ?? ""),
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
        ...(ed.estimate ? { estimate: { ...ed.estimate } } : {}),
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
    generated_at: fmtUTC(safeNow, "%Y-%m-%dT%H:%M:%SZ"),
    site: {
      domain,
      base_url: baseUrl,
    },
    sources,
    categories: { ...categories },
    conferences: outConfs,
  };
}

type JsonRecord = Record<string, unknown>;

function jsonRecords(value: unknown): JsonRecord[] {
  return Array.isArray(value)
    ? value.filter((item): item is JsonRecord => Boolean(item && typeof item === "object"))
    : [];
}

function jsonTime(value: unknown): number | null {
  const time = Date.parse(String(value ?? ""));
  return Number.isFinite(time) ? time : null;
}

function compactEdition(edition: JsonRecord, deadlines: JsonRecord[]): JsonRecord {
  return {
    year: edition.year,
    id: edition.id,
    link: edition.link,
    place: edition.place,
    date_text: edition.date_text,
    event_start: edition.event_start,
    event_end: edition.event_end,
    estimated: edition.estimated,
    ...(edition.estimate ? { estimate: edition.estimate } : {}),
    source: edition.source,
    deadlines,
  };
}

function compactConference(
  conf: JsonRecord,
  editions: JsonRecord[],
  withPapers: boolean,
): JsonRecord {
  return {
    key: conf.key,
    title: conf.title,
    full_name: conf.full_name,
    categories: conf.categories,
    rank: conf.rank,
    link: conf.link,
    tags: conf.tags,
    sources: conf.sources,
    editions,
    ...(withPapers ? { papers: conf.papers ?? [] } : {}),
  };
}

/** The deadline UI payload: metadata plus only the current/near deadline window. */
export function toCatalog(
  data: Record<string, unknown>,
  now: Date | null | undefined,
  days = 180,
): Record<string, unknown> {
  const safeNow = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const horizon = safeNow.getTime() + Math.max(1, days) * DAY_MS;
  const lookback = safeNow.getTime() - 30 * DAY_MS;
  const conferences = jsonRecords(data.conferences).map((conf) => {
    const editions = jsonRecords(conf.editions)
      .map((edition) => {
        const deadlines = jsonRecords(edition.deadlines).filter((deadline) => {
          const time = jsonTime(deadline.utc);
          return time !== null && time >= lookback && time <= horizon;
        });
        const eventStart = jsonTime(edition.event_start);
        const eventEnd = jsonTime(edition.event_end ?? edition.event_start);
        const inWindow =
          eventStart !== null && eventEnd !== null && eventEnd >= lookback && eventStart <= horizon;
        return inWindow || deadlines.length ? compactEdition(edition, deadlines) : null;
      })
      .filter((edition): edition is JsonRecord => edition !== null);
    return compactConference(conf, editions, false);
  });
  return {
    generated_at: data.generated_at,
    site: data.site,
    sources: data.sources,
    categories: data.categories,
    window: { lookback_days: 30, upcoming_days: Math.max(1, days) },
    history_ref: "data.json",
    recommendation_ref: "recommendation-index.json",
    conferences,
  };
}

/** The recommendation payload: venue profiles and one representative availability record. */
export function toRecommendationIndex(
  data: Record<string, unknown>,
  now: Date | null | undefined,
): Record<string, unknown> {
  const safeNow = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const conferences = jsonRecords(data.conferences).map((conf) => {
    const editions = jsonRecords(conf.editions)
      .map((edition) => {
        const deadlines = jsonRecords(edition.deadlines)
          .filter((deadline) => ["abstract", "paper"].includes(String(deadline.kind)))
          .sort(
            (a, b) =>
              (jsonTime(a.utc) ?? Number.MAX_SAFE_INTEGER) -
              (jsonTime(b.utc) ?? Number.MAX_SAFE_INTEGER),
          );
        if (!deadlines.length) return null;
        const future = deadlines.find(
          (deadline) => (jsonTime(deadline.utc) ?? 0) >= safeNow.getTime(),
        );
        return compactEdition(edition, [future ?? deadlines[deadlines.length - 1]]);
      })
      .filter((edition): edition is JsonRecord => edition !== null);
    return compactConference(conf, editions, true);
  });
  return {
    generated_at: data.generated_at,
    site: data.site,
    sources: data.sources,
    categories: data.categories,
    history_ref: "data.json",
    embedding_ref: "embeddings.json",
    embedding_manifest: embeddingManifest(data as Parameters<typeof embeddingManifest>[0]),
    conferences,
  };
}

export function csvField(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(records: DataRecord[] | null | undefined): string {
  const lines: string[] = [];
  lines.push(CSV_COLUMNS.join(","));
  for (const rec of records ?? []) {
    if (!rec || typeof rec !== "object" || rec.type !== "deadline") continue;
    const { conf, edition: ed, deadline: dl } = rec;
    if (!conf || !ed || dl === null || dl === undefined) continue;
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
        ed.estimate?.window_start ?? "",
        ed.estimate?.window_end ?? "",
        conf.sources.join(";"),
        ed.link || conf.link || "",
      ]
        .map((v) => csvField(v))
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

export function escapeMdCell(s: string | null | undefined): string {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/\|/g, "\\|")
    .replace(/[\r\n]+/g, " ")
    .trim();
}

/** Sanitize a URL embedded in a Markdown link [text](url) inside table cells. */
export function escapeMdUrl(url: string | null | undefined): string {
  if (!url) return "";
  let u = String(url)
    .trim()
    .replace(/[\r\n]+/g, "");
  u = u.replace(/\|/g, "%7C");
  u = u.replace(/\s+/g, "%20");
  u = u.replace(/\(/g, "%28").replace(/\)/g, "%29");
  return u;
}

export function toUpcomingMd(
  records: DataRecord[] | null | undefined,
  now: Date | null | undefined,
  days = 180,
): string {
  const safeNow = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const rawDays = Number(days);
  const safeDays =
    Number.isFinite(rawDays) && Number.isInteger(rawDays) && rawDays > 0 ? rawDays : 180;
  const horizon = addDays(safeNow, safeDays);
  const today = dateOnly(safeNow);
  const rows: string[] = [];
  for (const rec of records ?? []) {
    if (!rec || typeof rec !== "object") continue;
    const { conf, edition: ed } = rec;
    if (!conf || !ed) continue;
    const rawLink = ed.link || conf.link;
    const link = rawLink ? escapeMdUrl(rawLink) : "";
    const titleEscaped = escapeMdCell(titleWithYear(conf.title, ed.year));
    const name = link ? `[${titleEscaped}](${link})` : titleEscaped;
    const placeEscaped = escapeMdCell(ed.place);
    if (rec.type === "deadline") {
      const dl = rec.deadline;
      if (dl === null) continue;
      if (safeNow.getTime() > dl.at_utc.getTime() || dl.at_utc.getTime() > horizon.getTime())
        continue;
      const remainMs = dl.at_utc.getTime() - safeNow.getTime();
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
      const when =
        ed.estimated && ed.estimate
          ? `推定期間 ${ed.estimate.window_start}〜${ed.estimate.window_end}`
          : aoeText(dl.at_utc);
      const kindText = escapeMdCell(rec.kind_label);
      const roundText = `R${dl.round}`;
      rows.push(
        `| ${when} | ${left} | ${name} | ${kindText} | ${roundText} | ${ed.estimated ? "推定" : ""} | ${placeEscaped} |`,
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
        `| ${when} | ${left} | ${name} | 開催 | - | ${ed.estimated ? "推定" : ""} | ${placeEscaped} |`,
      );
    }
  }
  const head = [
    `# 直近 ${safeDays} 日の締切と開催`,
    "",
    `生成時刻: ${fmtUTC(safeNow, "%Y-%m-%dT%H:%M:%SZ")}`,
    "",
    "| 日付 | 残り | 会議 | 種別 | R | 推定 | 開催地 |",
    "|---|---|---|---|---|---|---|",
  ];
  if (rows.length === 0) rows.push("| - | - | 該当なし | - | - | - | - |");
  return `${[...head, ...rows].join("\n")}\n`;
}

export function toLlmsTxt(config: Record<string, unknown> | null | undefined): string {
  const safeConfig = config ?? {};
  const categories = (safeConfig.categories as Record<string, string> | null) ?? DEFAULT_CATEGORIES;
  const sources = (safeConfig.sources as Array<Record<string, unknown>> | null) ?? DEFAULT_SOURCES;
  // config.yaml の site.title をタイトル行に反映する（旧名 conf-deadlines のハードコードを廃止）。
  const siteTitle = String(
    (safeConfig.site as Record<string, unknown> | null)?.title ?? "kamiyobi",
  );
  const lines = [
    `# ${siteTitle}`,
    "",
    "HPC・ネットワーク・システム・AI 系の国際会議の投稿締切と開催日を、",
    "上流の公開データから日次で正規化して配信する静的データ集である。",
    "サーバは無く、GitHub Pages 上の静的ファイルだけで構成される。",
    "",
    "## 出力一覧",
    "",
    "- data.json — 正規化データ全体（機械可読の正）。",
    "- catalog.json — 締切画面向けの現在・近日期間カタログ。",
    "- recommendation-index.json — 投稿先推薦の会議プロフィールと埋め込み参照。",
    "- app.js — ブラウザUI runtime（TypeScript の allowJs 対象）。",
    "- data.csv — 1 行 1 締切のフラット表。",
    `- upcoming.md — 直近 ${String((safeConfig.site as Record<string, unknown> | null)?.upcoming_days ?? 180)} 日の締切と開催の表。`,
  ];
  lines.push(
    "",
    "## data.json のスキーマ要約",
    "",
    "トップレベルは以下のキーを持つオブジェクトである。",
    "",
    "- generated_at: string — 生成時刻。'YYYY-MM-DDTHH:MM:SSZ'（UTC）。",
    "- site: object — {domain: string, base_url: string}。配信サイトの所在。",
    "  公開サイトの絶対 URL を組み立てるには base_url を基準にする。",
    "- sources: array of {name, repo, license, url} — 出典と授権。",
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
    "  - papers: array of string — 代表採択論文タイトル。語彙一致・推薦に使う。",
    "    無い会議は空配列。",
    "  - editions: array — 開催回。各要素は次の形である。",
    "    - year: integer, id: string（例 'sigcomm26'）, link: string, place: string",
    "    - date_text: string — 上流の自由文の会期表記。構造化されていないことがある。",
    "    - event_start / event_end: string|null — 'YYYY-MM-DD'。パース不能なら null。",
    "    - estimated: boolean — true は過去実績からの推定。実データではない。",
    "    - estimate: object|null — 推定版の点推定・日付窓・根拠版・信頼度。確定版には無い。",
    "      window_start / window_end は表示用の日付範囲であり、公式締切ではない。",
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
    "- estimated=true の版は推定窓であり、公式サイトで締切を確認してから利用する。",
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
  confs: Conference[] | null | undefined,
  config: Record<string, unknown> | null | undefined,
  outdir: string,
  now: Date | null | undefined,
  opts: { noEmbeddings?: boolean } = {},
): Promise<BuildStats> {
  mkdirSync(outdir, { recursive: true });

  const safeConfs = Array.isArray(confs) ? confs : [];
  const safeConfig = config ?? {};

  const safeNow = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const nowUtc = new Date(safeNow.getTime());
  // DTSTAMP is derived from --now (floored to the day).
  const site = (safeConfig.site as Record<string, unknown>) ?? {};
  // config.yaml の site.upcoming_days（既定 180）: upcoming.md の窓を決める。
  // これまで宣言のみで読まれず 180 に固定されていた（#95）。
  const rawUpcomingDays = Number(site.upcoming_days ?? 180);
  const upcomingDays =
    Number.isFinite(rawUpcomingDays) && Number.isInteger(rawUpcomingDays) && rawUpcomingDays > 0
      ? rawUpcomingDays
      : 180;

  const records = recordsOf(safeConfs);
  records.sort((a, b) => {
    const [sa, sb] = [sortKey(a), sortKey(b)];
    return sa[0] - sb[0] || cmpStr(sa[1], sb[1]);
  });
  const written: string[] = [];

  const write = (name: string, text: string): void => {
    writeFileSync(join(outdir, name), text, "utf8");
    written.push(name);
  };

  const data = toJson(safeConfs, safeConfig, nowUtc);
  const jsonText = JSON.stringify(data, null, 2);
  write("data.json", `${jsonText}\n`);
  write("catalog.json", `${JSON.stringify(toCatalog(data, nowUtc, upcomingDays), null, 2)}\n`);
  write(
    "recommendation-index.json",
    `${JSON.stringify(toRecommendationIndex(data, nowUtc), null, 2)}\n`,
  );
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
        needEmb = embeddingsStale(existing, data);
      } catch {
        needEmb = true;
      }
      if (needEmb) {
        const { buildEmbeddings } = await import("./embeddings.ts");
        await buildEmbeddings(join(outdir, "data.json"), embPath);
      }
      written.push("embeddings.json");
    } catch (exc) {
      console.warn(
        `warning: embeddings を生成しなかった（${(exc as Error).constructor.name}: ${String(exc)}）`,
      );
    }
  }

  write("llms.txt", toLlmsTxt(safeConfig));
  write(".nojekyll", "");

  const template = String(safeConfig.template ?? "site/template.html");
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
      templateText = templateText.replace(
        TEMPLATE_MARKER,
        embedJson(pyJsonCompact(toCatalog(data, nowUtc, upcomingDays))),
      );
    }
    write("index.html", templateText);
    // recommender.js をテンプレートと同じ場所から同梱（ブラウザから src 参照。無ければ site/recommender.js へフォールバック）
    const rec = join(dirname(templatePath), "recommender.js");
    let recContent: string | null = null;
    try {
      recContent = readFileSync(rec, "utf8");
    } catch {
      try {
        recContent = readFileSync(join(ROOT, "site", "recommender.js"), "utf8");
      } catch {
        console.warn(`warning: recommender.js が無い。index.html の src 参照が 404 になる`);
      }
    }
    if (recContent !== null) {
      write("recommender.js", recContent);
    }
    const app = join(dirname(templatePath), "app.js");
    let appContent: string | null = null;
    try {
      appContent = readFileSync(app, "utf8");
    } catch {
      try {
        appContent = readFileSync(join(ROOT, "site", "app.js"), "utf8");
      } catch {
        console.warn(`warning: app.js が無い。index.html の src 参照が 404 になる`);
      }
    }
    if (appContent !== null) {
      write("app.js", appContent);
    }
  } else {
    console.warn(`warning: ${templatePath} が無いので index.html を生成しない`);
  }

  const nDeadlines = records.filter((r) => r.type === "deadline").length;
  return {
    generated_at: String(data.generated_at),
    conferences: safeConfs.length,
    editions: safeConfs.reduce((n, c) => n + (c?.editions?.length ?? 0), 0),
    deadlines: nDeadlines,
    events: records.length - nDeadlines,
    estimated: records.filter((r) => r.estimated).length,
    files: written,
  };
}
