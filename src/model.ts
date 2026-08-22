/**
 * Core types, timezone resolution and date parsers.
 *
 * This module is the single place where upstream free-form values are turned
 * into structured data.  Nothing here throws on bad input: unparsable values
 * become `null` and a de-duplicated warning is written to stderr.
 *
 * Ported from scripts/model.py (kamiyobi).
 */

export const DAY_MS = 86_400_000;

/** Anywhere on Earth: UTC-12. */
export const AOE_OFFSET_MINUTES = -12 * 60;

export type DeadlineKind =
  | "abstract"
  | "paper"
  | "supplementary"
  | "notification"
  | "camera_ready"
  | "rebuttal_start"
  | "rebuttal_end"
  | "review_release"
  | "registration"
  | "other";

export const KINDS: readonly string[] = [
  "abstract",
  "paper",
  "supplementary",
  "notification",
  "camera_ready",
  "rebuttal_start",
  "rebuttal_end",
  "review_release",
  "registration",
  "other",
];

export type DeadlineConfidence = "official" | "aggregator" | "estimated";

export interface DeadlineEvidence {
  source_name: string;
  source_url: string;
  observed_at: string;
  original_value: string;
  confidence: DeadlineConfidence;
}

export interface Deadline {
  kind: DeadlineKind;
  label: string;
  /** tz-aware, always UTC. */
  at_utc: Date;
  tz_raw: string;
  round: number;
  comment: string | null;
  /** Raw candidate value retained for provenance during serialization. */
  raw_value?: string;
  evidence?: DeadlineEvidence[];
  conflicts?: DeadlineConflict[];
  selection_rule?: string;
}

export interface DeadlineConflict {
  at_utc: Date;
  label: string;
  source: string;
  raw_value?: string;
  evidence?: DeadlineEvidence;
}

export interface DeadlineEstimate {
  point_estimate: string;
  window_start: string;
  window_end: string;
  source_editions: number[];
  method: "median-interval";
  confidence: "low" | "medium";
}

export interface Edition {
  year: number;
  edition_id: string;
  link: string;
  place: string;
  date_text: string;
  /** Date-only values kept as UTC midnights. */
  event_start: Date | null;
  event_end: Date | null;
  deadlines: Deadline[];
  estimated: boolean;
  estimate?: DeadlineEstimate;
  source: string;
}

export interface Conference {
  key: string;
  title: string;
  full_name: string;
  link: string;
  rank: Record<string, string>;
  dblp: string | null;
  upstream_sub: string | null;
  tags: string[];
  categories: string[];
  editions: Edition[];
  sources: string[];
}

// --------------------------------------------------------------------------
// warnings (aggregated; each distinct message is printed once)
// --------------------------------------------------------------------------

const WARNINGS = new Map<string, number>();

export function warn(message: string): void {
  const n = (WARNINGS.get(message) ?? 0) + 1;
  WARNINGS.set(message, n);
  if (n === 1) {
    process.stderr.write(`warning: ${message}\n`);
  }
}

export function warningCounts(): Record<string, number> {
  return Object.fromEntries(WARNINGS);
}

export function resetWarnings(): void {
  WARNINGS.clear();
}

// --------------------------------------------------------------------------
// date helpers (all values are UTC; date-only values are UTC midnights)
// --------------------------------------------------------------------------

export function addDays(d: Date | null | undefined, n: number): Date {
  const base = d instanceof Date && !Number.isNaN(d.getTime()) ? d : new Date(0);
  return new Date(base.getTime() + (Number(n) || 0) * DAY_MS);
}

/** The calendar day of `d` as a UTC midnight. */
export function dateOnly(d: Date | null | undefined): Date {
  const base = d instanceof Date && !Number.isNaN(d.getTime()) ? d : new Date(0);
  return new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()));
}

const PAD2 = (n: number): string => String(n).padStart(2, "0");

/** Python's str ordering: code-point order, locale-independent. */
export function cmpStr(a: string | null | undefined, b: string | null | undefined): number {
  const sa = String(a ?? "");
  const sb = String(b ?? "");
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** 'YYYY-MM-DD' in UTC. */
export function fmtDate(d: Date | null | undefined): string {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "";
  return `${d.getUTCFullYear()}-${PAD2(d.getUTCMonth() + 1)}-${PAD2(d.getUTCDate())}`;
}

/** strftime subset: %Y %m %d %H %M %S (UTC). */
export function fmtUTC(d: Date | null | undefined, pattern: string | null | undefined): string {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "";
  const pat = String(pattern ?? "");
  return pat
    .replace(/%Y/g, String(d.getUTCFullYear()))
    .replace(/%m/g, PAD2(d.getUTCMonth() + 1))
    .replace(/%d/g, PAD2(d.getUTCDate()))
    .replace(/%H/g, PAD2(d.getUTCHours()))
    .replace(/%M/g, PAD2(d.getUTCMinutes()))
    .replace(/%S/g, PAD2(d.getUTCSeconds()));
}

/** Parse 'YYYY-MM-DD' (or a Date) into a UTC midnight, or null. */
export function asDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return dateOnly(value);
  const s = String(value).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (
    d.getUTCFullYear() !== Number(m[1]) ||
    d.getUTCMonth() !== Number(m[2]) - 1 ||
    d.getUTCDate() !== Number(m[3])
  ) {
    return null;
  }
  return d;
}

// --------------------------------------------------------------------------
// slug
// --------------------------------------------------------------------------

/** Normalize a conference title into a key: 'IH&MMSec' -> 'ih-mmsec'. */
export function slug(title: string | null | undefined): string {
  return String(title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// --------------------------------------------------------------------------
// timezone
// --------------------------------------------------------------------------

const TZ_FIXED: Record<string, number> = {
  utc: 0,
  gmt: 0,
  ut: 0,
  z: 0,
  aoe: AOE_OFFSET_MINUTES,
};

/** Abbreviations whose standard/daylight meaning is explicit. */
const TZ_FIXED_ABBREVIATIONS: Record<string, number> = {
  pst: -8 * 60,
  pdt: -7 * 60,
  mst: -7 * 60,
  mdt: -6 * 60,
  est: -5 * 60,
  edt: -4 * 60,
  cet: 60,
  cest: 120,
  akst: -9 * 60,
  akdt: -8 * 60,
  hst: -10 * 60,
};

const TZ_NAMED: Record<string, string> = {
  pt: "America/Los_Angeles",
  mt: "America/Denver",
  ct: "America/Chicago",
  cdt: "America/Chicago",
  et: "America/New_York",
  jst: "Asia/Tokyo",
  kst: "Asia/Seoul",
  sgt: "Asia/Singapore",
  hkt: "Asia/Hong_Kong",
};

/** These abbreviations name different zones unless the source gives context. */
const TZ_AMBIGUOUS = new Set(["cst", "ist", "bst"]);

const TZ_OFFSET_RE = /^(?:utc|gmt)?\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/;

export type Tz = { kind: "fixed"; offsetMinutes: number } | { kind: "iana"; name: string };
export type TzResolution = { status: "confirmed"; tz: Tz } | { status: "unconfirmed" };

/** Classify whether an upstream zone is precise enough to publish as UTC. */
export function resolveTzStatus(tzRaw: string | null | undefined): TzResolution {
  if (tzRaw === null || tzRaw === undefined) return { status: "unconfirmed" };
  const raw = String(tzRaw).trim();
  const low = raw.toLowerCase();

  if (!raw || TZ_AMBIGUOUS.has(low)) return { status: "unconfirmed" };
  if (low in TZ_FIXED) {
    return {
      status: "confirmed",
      tz: { kind: "fixed", offsetMinutes: TZ_FIXED[low] },
    };
  }
  if (low in TZ_FIXED_ABBREVIATIONS) {
    return {
      status: "confirmed",
      tz: { kind: "fixed", offsetMinutes: TZ_FIXED_ABBREVIATIONS[low] },
    };
  }
  if (low in TZ_NAMED) {
    return {
      status: "confirmed",
      tz: { kind: "iana", name: TZ_NAMED[low] },
    };
  }

  const m = TZ_OFFSET_RE.exec(low);
  if (m) {
    const sign = m[1] === "-" ? -1 : 1;
    const hours = Number(m[2]);
    const minutes = Number(m[3] ?? 0);
    // Reject impossible numeric offsets (minute > 59, or |offset| >= 24 h)
    // instead of silently shifting the deadline; fall through to the
    // unknown-timezone warning and UTC fallback below.
    if (hours <= 23 && minutes <= 59) {
      return {
        status: "confirmed",
        tz: { kind: "fixed", offsetMinutes: sign * (hours * 60 + minutes) },
      };
    }
  }

  if (raw.includes("/")) {
    try {
      // Intl throws RangeError for unknown timezone names.
      new Intl.DateTimeFormat("en-US", { timeZone: raw });
      return { status: "confirmed", tz: { kind: "iana", name: raw } };
    } catch {
      warn(`unknown IANA timezone ${JSON.stringify(raw)}; using UTC`);
      return { status: "unconfirmed" };
    }
  }

  warn(`unknown timezone ${JSON.stringify(raw)}; using UTC`);
  return { status: "unconfirmed" };
}

/** Backward-compatible resolver for code that only needs a usable zone. */
export function resolveTz(tzRaw: string | null | undefined): Tz {
  const resolution = resolveTzStatus(tzRaw);
  return resolution.status === "confirmed" ? resolution.tz : { kind: "fixed", offsetMinutes: 0 };
}

/** Whether `parseInstant` will accept this zone as a confirmed instant. */
export function isConfirmedTimezone(tzRaw: string | null | undefined): boolean {
  return resolveTzStatus(tzRaw).status === "confirmed";
}

/** Offset of `tz` at instant `utcMs`, in minutes. */
function tzOffsetMinutes(utcMs: number, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  let hour = get("hour");
  let day = get("day");
  // Some locales/engines render midnight as '24' with the next day.
  if (hour === 24) {
    hour = 0;
    day += 1;
  }
  const local = Date.UTC(get("year"), get("month") - 1, day, hour, get("minute"), get("second"));
  return (local - utcMs) / 60_000;
}

/** Convert a naive wall-clock time (UTC-ms components) into UTC via `tz`. */
function zonedTimeToUtc(
  parts: {
    y: number;
    m: number;
    d: number;
    h: number;
    min: number;
    s: number;
  },
  tz: string,
): Date {
  let guess = Date.UTC(parts.y, parts.m - 1, parts.d, parts.h, parts.min, parts.s);
  for (let i = 0; i < 3; i++) {
    const off = tzOffsetMinutes(guess, tz);
    const candidate = guess - off * 60_000;
    if (tzOffsetMinutes(candidate, tz) === off) return new Date(candidate);
    guess = candidate;
  }
  return new Date(guess - tzOffsetMinutes(guess, tz) * 60_000);
}

/** Apply a tz descriptor to a naive wall-clock instant (ms), returning UTC. */
export function applyTz(naiveMs: number, tz: Tz): Date {
  if (tz.kind === "fixed") return new Date(naiveMs - tz.offsetMinutes * 60_000);
  const d = new Date(naiveMs);
  return zonedTimeToUtc(
    {
      y: d.getUTCFullYear(),
      m: d.getUTCMonth() + 1,
      d: d.getUTCDate(),
      h: d.getUTCHours(),
      min: d.getUTCMinutes(),
      s: d.getUTCSeconds(),
    },
    tz.name,
  );
}

// --------------------------------------------------------------------------
// instants
// --------------------------------------------------------------------------

interface Naive {
  y: number;
  m: number;
  d: number;
  h: number;
  min: number;
  s: number;
  ms: number;
}

/** 'YYYY-MM-DD[ HH:MM[:SS[.sss]]]' (after 'T' -> ' ' and trailing 'Z' stripping). */
function parseNaive(s: string): Naive | null {
  let m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(s);
  if (m) {
    const rawFrac = m[7] ?? "";
    const ms = rawFrac ? Number(rawFrac.slice(0, 3).padEnd(3, "0")) : 0;
    return validTime(+m[4], +m[5], +m[6])
      ? { y: +m[1], m: +m[2], d: +m[3], h: +m[4], min: +m[5], s: +m[6], ms }
      : null;
  }
  m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(s);
  if (m) {
    return validTime(+m[4], +m[5], 0)
      ? { y: +m[1], m: +m[2], d: +m[3], h: +m[4], min: +m[5], s: 0, ms: 0 }
      : null;
  }
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    return { y: +m[1], m: +m[2], d: +m[3], h: 23, min: 59, s: 59, ms: 0 };
  }
  return null;
}

/** Reject out-of-range wall-clock time components (00:00–23:59:59). */
function validTime(h: number, min: number, s: number): boolean {
  return h <= 23 && min <= 59 && s <= 59;
}

function naiveToMs(n: Naive): number | null {
  const ms = Date.UTC(n.y, n.m - 1, n.d, n.h, n.min, n.s, n.ms);
  const check = new Date(ms);
  if (
    check.getUTCFullYear() !== n.y ||
    check.getUTCMonth() !== n.m - 1 ||
    check.getUTCDate() !== n.d
  ) {
    return null; // e.g. Feb 30
  }
  return ms;
}

/** Parse an upstream deadline into an aware UTC Date, or null. */
export function parseInstant(text: unknown, tzRaw: string | null | undefined): Date | null {
  if (text === null || text === undefined) return null;
  let s = String(text).trim().replace("T", " ").trim();
  if (s.endsWith("Z")) s = s.slice(0, -1).trim();
  const naive = parseNaive(s);
  if (!naive) {
    warn(`unparsable deadline ${JSON.stringify(String(text))}`);
    return null;
  }
  const ms = naiveToMs(naive);
  if (ms === null) {
    warn(`unparsable deadline ${JSON.stringify(String(text))}`);
    return null;
  }
  const resolution = resolveTzStatus(tzRaw);
  if (resolution.status !== "confirmed") return null;
  return applyTz(ms, resolution.tz);
}

// --------------------------------------------------------------------------
// date ranges
// --------------------------------------------------------------------------

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

const KNOWN_MONTH_TYPOS: Record<string, number> = {
  // Upstream typos such as 'Septemper' (APWeb-WAIM 2024).
  septemper: 9,
};

export function monthOf(word: string): number | null {
  const w = word.toLowerCase();
  if (w.length < 3) return null;
  if (w in KNOWN_MONTH_TYPOS) return KNOWN_MONTH_TYPOS[w];
  for (let i = 0; i < MONTHS.length; i++) {
    if (MONTHS[i].startsWith(w)) return i + 1;
  }
  return null;
}

const TOKEN_RE = /([A-Za-z]+)|(\d{1,4})/g;

/** Pull the first month / day / year out of one side of a range. */
function scan(part: string): {
  month: number | null;
  day: number | null;
  year: number | null;
  invalidDay: boolean;
} {
  let month: number | null = null;
  let day: number | null = null;
  let year: number | null = null;
  let invalidDay = false;
  for (const m of part.matchAll(TOKEN_RE)) {
    const word = m[1];
    const num = m[2];
    if (word !== undefined) {
      if (month === null) month = monthOf(word);
    } else {
      const n = Number(num);
      if (num.length === 4) {
        if (year === null) year = n;
      } else if (n >= 1 && n <= 31 && day === null) {
        day = n;
      } else if (day === null) {
        // Explicit but impossible day (0, 32+, 3-digit): fail closed
        // instead of degrading to a fabricated month-only span.
        invalidDay = true;
      }
    }
  }
  return { month, day, year, invalidDay };
}

function mkdate(year: number, month: number, day: number): Date | null {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return d;
}

/** First and last calendar day of `month` in `year`. */
function monthSpan(year: number, month: number): [Date | null, Date | null] {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return [mkdate(year, month, 1), mkdate(year, month, last)];
}

/** Parse numeric date forms: 'YYYY-MM-DD - YYYY-MM-DD', 'YYYY-MM-DD to YYYY-MM-DD', 'YYYY/MM/DD', 'YYYY-MM-DD', etc. */
function parseNumericRange(s: string): { matched: boolean; range: [Date | null, Date | null] } {
  // YYYY-MM-DD - YYYY-MM-DD or YYYY/MM/DD - YYYY/MM/DD or YYYY.MM.DD - YYYY.MM.DD
  // Also supports YYYY-MM-DD - MM-DD
  let m =
    /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\s*(?:[-–—~]|to|through|until)\s*(?:(\d{4})[-/.])?(\d{1,2})[-/.](\d{1,2})$/i.exec(
      s,
    );
  if (m) {
    const y1 = Number(m[1]);
    const m1 = Number(m[2]);
    const d1 = Number(m[3]);
    const y2 = m[4] ? Number(m[4]) : m1 > Number(m[5]) ? y1 + 1 : y1;
    const m2 = Number(m[5]);
    const d2 = Number(m[6]);
    const start = mkdate(y1, m1, d1);
    const end = mkdate(y2, m2, d2);
    if (start && end && start <= end) {
      return { matched: true, range: [start, end] };
    }
    return { matched: true, range: [null, null] };
  }
  // YYYY-MM-DD - DD
  m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\s*(?:[-–—~]|to|through|until)\s*(\d{1,2})$/i.exec(s);
  if (m) {
    const y1 = Number(m[1]);
    const m1 = Number(m[2]);
    const d1 = Number(m[3]);
    const d2 = Number(m[4]);
    const start = mkdate(y1, m1, d1);
    const end = mkdate(y1, m1, d2);
    if (start && end && start <= end) {
      return { matched: true, range: [start, end] };
    }
    return { matched: true, range: [null, null] };
  }
  // Single YYYY-MM-DD or YYYY/MM/DD or YYYY.MM.DD
  m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (m) {
    const d = mkdate(Number(m[1]), Number(m[2]), Number(m[3]));
    if (d) {
      return { matched: true, range: [d, d] };
    }
    return { matched: true, range: [null, null] };
  }
  return { matched: false, range: [null, null] };
}

function parseJapaneseRange(
  s: string,
  fallbackYear: number,
): { matched: boolean; range: [Date | null, Date | null] } {
  // 全角数字・記号を正規化 (２０２６ -> 2026, ～ -> 〜)
  // extra.yaml: '特集号予定 2027年9月号' — drop a leading label before YYYY年
  // and a trailing 号 (journal-issue marker) so the existing month branch matches (#376).
  let norm = s.normalize("NFKC").replace(/\s+/g, "");
  norm = norm.replace(/^.*?(?=\d{4}年)/u, "").replace(/号$/u, "");

  // 1. 日付範囲: YYYY年M月D日[〜-]YYYY年M月D日 / YYYY年M月D日[〜-]M月D日 / YYYY年M月D日[〜-]D日
  let m =
    /^(\d{4})年(\d{1,2})月(\d{1,2})日\s*(?:[〜~～\-–—]|から|to)\s*(?:(\d{4})年)?(?:(\d{1,2})月)?(\d{1,2})日$/i.exec(
      norm,
    );
  if (m) {
    const y1 = Number(m[1]);
    const m1 = Number(m[2]);
    const d1 = Number(m[3]);
    const m2 = m[5] ? Number(m[5]) : m1;
    const y2 = m[4] ? Number(m[4]) : m1 > m2 ? y1 + 1 : y1;
    const d2 = Number(m[6]);
    const start = mkdate(y1, m1, d1);
    const end = mkdate(y2, m2, d2);
    if (start && end && start <= end) {
      return { matched: true, range: [start, end] };
    }
    return { matched: true, range: [null, null] };
  }

  // 2. 月度範囲: YYYY年M月[〜-]YYYY年M月 / YYYY年M月[〜-]M月
  m = /^(\d{4})年(\d{1,2})月\s*(?:[〜~～\-–—]|から|to)\s*(?:(\d{4})年)?(\d{1,2})月$/i.exec(norm);
  if (m) {
    const y1 = Number(m[1]);
    const m1 = Number(m[2]);
    const m2 = Number(m[4]);
    const y2 = m[3] ? Number(m[3]) : m1 > m2 ? y1 + 1 : y1;
    const [start] = monthSpan(y1, m1);
    const [, end] = monthSpan(y2, m2);
    if (start && end && start <= end) {
      return { matched: true, range: [start, end] };
    }
    return { matched: true, range: [null, null] };
  }

  // 3. 単一日付: YYYY年M月D日 / M月D日
  m = /^(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日$/.exec(norm);
  if (m) {
    const y = m[1] ? Number(m[1]) : fallbackYear;
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const one = mkdate(y, mo, d);
    if (one) {
      return { matched: true, range: [one, one] };
    }
    return { matched: true, range: [null, null] };
  }

  // 4. 単一月: YYYY年M月 / M月
  m = /^(?:(\d{4})年)?(\d{1,2})月$/.exec(norm);
  if (m) {
    const y = m[1] ? Number(m[1]) : fallbackYear;
    const mo = Number(m[2]);
    const [start, end] = monthSpan(y, mo);
    if (start && end) {
      return { matched: true, range: [start, end] };
    }
    return { matched: true, range: [null, null] };
  }

  return { matched: false, range: [null, null] };
}

/**
 * Parse free-form event dates such as 'September 29 - October 3, 2025'.
 * Also accepts month-only forms: 'November, 2026', 'March-April, 2025',
 * 'August 2027 (exact dates TBD)', and Japanese formats ('2026年8月17日〜21日').
 */
export function parseDateRange(
  text: string | null | undefined,
  fallbackYear: number,
): [Date | null, Date | null] {
  if (!text) return [null, null];

  let s = String(text).replace(/[\u2010-\u2015\u2212]/g, "-");
  s = s.replace(/\s+/g, " ").trim();
  // Drop trailing parenthetical notes (回次・併催名・TBD・場所など).
  // extra.yaml house style: '2026年8月6日-7日 (SWoPP 2026 / 第205回)' (#368).
  // ASCII and fullwidth parens; repeat so stacked notes fall off.
  for (;;) {
    const stripped = s.replace(/\s*[(（][^)）]*[)）]\s*$/u, "").trim();
    if (stripped === s) break;
    s = stripped;
  }

  const num = parseNumericRange(s);
  if (num.matched) {
    if (num.range[0] === null || num.range[1] === null) {
      warn(`unparsable event date ${JSON.stringify(String(text))}`);
      return [null, null];
    }
    return num.range;
  }

  const jp = parseJapaneseRange(s, fallbackYear);
  if (jp.matched) {
    if (jp.range[0] === null || jp.range[1] === null) {
      warn(`unparsable event date ${JSON.stringify(String(text))}`);
      return [null, null];
    }
    return jp.range;
  }

  // 'September 29 to October 2, 2026' spells the range in words.
  s = s.replace(/\s+(?:to|through|until)\s+/gi, "-");
  const [left, right] = s.split("-", 2);
  const parts = right === undefined ? [left] : [left, right];

  const m1 = scan(parts[0]);
  if (parts.length === 1) {
    if (m1.month === null || m1.invalidDay) {
      // A standalone four-digit year is an intentional year-only value
      // (e.g. data/extra.yaml IPSJ/IEICE editions whose exact dates are
      // not published): keep the null pair silently.  'TBD 2027' is the
      // same contract with an explicit unpublished marker (#388).
      // An impossible day (0, 32+, 3-digit) is not: fail closed instead
      // of fabricating a month-only span.
      if (!m1.invalidDay && !/^\d{4}$/.test(s) && !/^TBD\s+\d{4}$/i.test(s)) {
        warn(`unparsable event date ${JSON.stringify(String(text))}`);
      }
      return [null, null];
    }
    const year = m1.year ?? fallbackYear;
    if (m1.day === null) {
      // Month-only: 'November, 2026' / 'Oct, 2022'.
      return monthSpan(year, m1.month);
    }
    const one = mkdate(year, m1.month, m1.day);
    if (one === null) {
      // Impossible calendar date (e.g. September 31, non-leap February 29):
      // fail closed like the range branch, and warn instead of silently
      // dropping the event from every output.
      warn(`unparsable event date ${JSON.stringify(String(text))}`);
      return [null, null];
    }
    return [one, one];
  }

  const m2 = scan(parts[1]);
  const m1m = m1.month ?? m2.month;
  const m2m = m2.month ?? m1m;
  if (m1m === null || m2m === null || m1.invalidDay || m2.invalidDay) {
    warn(`unparsable event date ${JSON.stringify(String(text))}`);
    return [null, null];
  }

  // Month-only range: 'March-April, 2025'.
  if (m1.day === null && m2.day === null) {
    let y1 = m1.year;
    let y2 = m2.year;
    if (y1 === null && y2 === null) {
      y1 = y2 = fallbackYear;
    } else if (y1 === null) {
      // The stated year belongs to the second month: a descending range
      // ('October - February, 2026') crosses into the previous year, same
      // convention as the day-form branch below ('December 28 - January 3,
      // 2026' -> 2025-12-28..2026-01-03).
      y1 = (m1m > m2m ? (y2 ?? fallbackYear) - 1 : y2) ?? fallbackYear;
    } else if (y2 === null) {
      y2 = m2m < m1m ? y1 + 1 : y1;
    }
    const [start] = monthSpan(y1, m1m);
    const [, end] = monthSpan(y2!, m2m);
    if (start === null || end === null || start > end) {
      warn(`unparsable event date ${JSON.stringify(String(text))}`);
      return [null, null];
    }
    return [start, end];
  }

  if (m1.day === null || m2.day === null) {
    warn(`unparsable event date ${JSON.stringify(String(text))}`);
    return [null, null];
  }

  let y1 = m1.year;
  let y2 = m2.year;
  if (y1 === null && y2 === null) {
    y1 = y2 = fallbackYear;
  } else if (y1 === null) {
    y1 = (m1m > m2m ? (y2 ?? fallbackYear) - 1 : y2) ?? fallbackYear;
  } else if (y2 === null) {
    y2 = m2m < m1m ? y1 + 1 : y1;
  }

  const start = mkdate(y1!, m1m, m1.day);
  const end = mkdate(y2!, m2m, m2.day);
  if (start === null || end === null || start > end) {
    warn(`unparsable event date ${JSON.stringify(String(text))}`);
    return [null, null];
  }
  return [start, end];
}

// --------------------------------------------------------------------------
// deadline kinds
// --------------------------------------------------------------------------

const PAPER = new Set(["deadline", "paper", "submission", "full_paper"]);
const CAMERA = new Set([
  "camera_ready",
  "camera_ready_deadline",
  "camera",
  "revision_deadline",
  "final_paper",
  "final_submission",
]);
const REBUTTAL_END = new Set([
  "rebuttal_end",
  "rebuttal",
  "rebuttal_and_revision",
  "author_response",
]);
const REGISTRATION = new Set(["registration", "reviewer_registration", "commitment_deadline"]);

/** Normalize an upstream deadline type name into one of the 10 kinds. */
export function kindOf(rawTypeOrKey: string | null | undefined): DeadlineKind {
  const s = String(rawTypeOrKey ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (s.startsWith("abstract")) return "abstract";
  if (s.includes("notification")) return "notification";
  if (PAPER.has(s)) return "paper";
  if (s === "supplementary") return "supplementary";
  if (CAMERA.has(s) || s.includes("camera_ready")) return "camera_ready";
  if (s === "rebuttal_start") return "rebuttal_start";
  if (REBUTTAL_END.has(s)) return "rebuttal_end";
  if (s === "review_release") return "review_release";
  if (REGISTRATION.has(s)) return "registration";
  return "other";
}

const ROMAN_NUMERALS: Record<string, number> = {
  i: 1,
  ii: 2,
  iii: 3,
  iv: 4,
  v: 5,
  vi: 6,
  vii: 7,
  viii: 8,
  ix: 9,
  x: 10,
};

const KANJI_NUMERALS: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

const ROUND_PATTERNS = [
  /\b(?:round|cycle|phase|stage)\s*#?\s*([0-9]+)\b/i,
  /\b([0-9]+)(?:st|nd|rd|th)\s+(?:round|cycle|phase|stage)\b/i,
  /\b(?:round|cycle|phase|stage)\s*#?\s*(i|ii|iii|iv|v|vi|vii|viii|ix|x)\b/i,
  /\br([1-9][0-9]?)\b/i,
  /第\s*([0-9]+|[一二三四五六七八九十]+)\s*(?:回|次|期)/,
  /([0-9]+|[一二三四五六七八九十]+)\s*次(?:締切|募集|提出)/,
  /([0-9]+|[一二三四五六七八九十]+)\s*回目/,
];

/** Submission round stated in a free-form label, else `default`. */
export function roundOf(label: string | null | undefined, defaultRound = 1): number {
  const s = String(label ?? "").normalize("NFKC");
  for (const pattern of ROUND_PATTERNS) {
    const match = pattern.exec(s);
    if (match) {
      const raw = match[1].toLowerCase();
      if (raw in ROMAN_NUMERALS) return ROMAN_NUMERALS[raw];
      if (raw in KANJI_NUMERALS) return KANJI_NUMERALS[raw];
      const value = Number(raw);
      if (value >= 1) return value;
    }
  }
  return defaultRound;
}

// --------------------------------------------------------------------------
// snapshot restore (SPEC.md section 6: keep building when upstream is down)
// --------------------------------------------------------------------------

/** 配列・文字列両対応の string[] 正規化（sources 層と同じ挙動: trim・空要素除去）。 */
function toStringArray(val: unknown): string[] {
  if (Array.isArray(val)) {
    return val
      .filter((x) => x !== null && x !== undefined)
      .map((x) => String(x).trim())
      .filter(Boolean);
  }
  if (typeof val === "string" && val.trim() !== "") {
    return [val.trim()];
  }
  return [];
}

function deadlineEstimateOf(value: unknown): DeadlineEstimate | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const sourceEditions = Array.isArray(raw.source_editions)
    ? raw.source_editions.map(Number).filter(Number.isInteger)
    : [];
  if (
    typeof raw.point_estimate !== "string" ||
    typeof raw.window_start !== "string" ||
    typeof raw.window_end !== "string" ||
    sourceEditions.length === 0 ||
    raw.method !== "median-interval" ||
    (raw.confidence !== "low" && raw.confidence !== "medium")
  ) {
    return undefined;
  }
  return {
    point_estimate: raw.point_estimate,
    window_start: raw.window_start,
    window_end: raw.window_end,
    source_editions: sourceEditions,
    method: "median-interval",
    confidence: raw.confidence,
  };
}

/** Rebuild conferences from a `data.json`-shaped payload. */
export function conferencesFromJson(
  payload: Record<string, unknown> | null | undefined,
): Conference[] {
  if (!payload || typeof payload !== "object") return [];
  const out: Conference[] = [];
  for (const raw of (payload.conferences as unknown[] | undefined) ?? []) {
    if (!raw || typeof raw !== "object") continue;
    const conf = raw as Record<string, unknown>;
    const editions: Edition[] = [];
    for (const edRaw of (conf.editions as unknown[] | undefined) ?? []) {
      if (!edRaw || typeof edRaw !== "object") continue;
      const ed = edRaw as Record<string, unknown>;
      const year = Number(ed.year);
      if (!Number.isInteger(year) || year <= 0) continue;
      const deadlines: Deadline[] = [];
      for (const dlRaw of (ed.deadlines as unknown[] | undefined) ?? []) {
        if (!dlRaw || typeof dlRaw !== "object") continue;
        const dl = dlRaw as Record<string, unknown>;
        if (!isConfirmedTimezone(String(dl.tz_raw ?? ""))) continue;
        const at = parseInstant(dl.utc, "UTC");
        if (at === null) continue;
        const evidence = (Array.isArray(dl.evidence) ? dl.evidence : [])
          .filter((item): item is Record<string, unknown> =>
            Boolean(item && typeof item === "object"),
          )
          .map(
            (item): DeadlineEvidence => ({
              source_name: String(item.source_name ?? ""),
              source_url: String(item.source_url ?? ""),
              observed_at: String(item.observed_at ?? ""),
              original_value: String(item.original_value ?? ""),
              confidence:
                item.confidence === "official" ||
                item.confidence === "estimated" ||
                item.confidence === "aggregator"
                  ? item.confidence
                  : "aggregator",
            }),
          )
          .filter((item) => item.source_name && item.original_value);
        const conflicts = (Array.isArray(dl.conflicts) ? dl.conflicts : [])
          .filter((item): item is Record<string, unknown> =>
            Boolean(item && typeof item === "object"),
          )
          .map((item) => {
            const rawEvidence =
              item.evidence && typeof item.evidence === "object"
                ? (item.evidence as Record<string, unknown>)
                : {};
            const conflictAt = parseInstant(
              item.at_utc ?? item.atUtc ?? item.original_value ?? rawEvidence.original_value,
              "UTC",
            );
            if (conflictAt === null) return null;
            const rawValue = String(
              item.original_value ?? rawEvidence.original_value ?? conflictAt.toISOString(),
            );
            const source = String(item.source ?? rawEvidence.source_name ?? "");
            const conflictEvidence: DeadlineEvidence | undefined =
              rawEvidence.source_name || rawEvidence.original_value
                ? {
                    source_name: String(rawEvidence.source_name ?? source),
                    source_url: String(rawEvidence.source_url ?? ""),
                    observed_at: String(rawEvidence.observed_at ?? ""),
                    original_value: String(rawEvidence.original_value ?? rawValue),
                    confidence:
                      rawEvidence.confidence === "official" ||
                      rawEvidence.confidence === "estimated" ||
                      rawEvidence.confidence === "aggregator"
                        ? rawEvidence.confidence
                        : "aggregator",
                  }
                : undefined;
            const conflict: DeadlineConflict = {
              at_utc: conflictAt,
              label: String(item.label ?? ""),
              source,
              raw_value: rawValue,
              ...(conflictEvidence ? { evidence: conflictEvidence } : {}),
            };
            return conflict;
          })
          .filter((item): item is DeadlineConflict => item !== null);
        deadlines.push({
          kind: kindOf(String(dl.kind ?? "other")),
          label: String(dl.label ?? ""),
          at_utc: at,
          tz_raw: String(dl.tz_raw ?? ""),
          round: Number(dl.round ?? 1) || 1,
          comment: dl.comment === null || dl.comment === undefined ? null : String(dl.comment),
          ...(evidence.length > 0 ? { evidence } : {}),
          ...(conflicts.length > 0 ? { conflicts } : {}),
          ...(typeof dl.selection_rule === "string" ? { selection_rule: dl.selection_rule } : {}),
        });
      }
      editions.push({
        year,
        edition_id: String(ed.id ?? ""),
        link: String(ed.link ?? ""),
        place: String(ed.place ?? ""),
        date_text: String(ed.date_text ?? ""),
        event_start: asDate(ed.event_start),
        event_end: asDate(ed.event_end),
        deadlines,
        estimated: Boolean(ed.estimated),
        ...(deadlineEstimateOf(ed.estimate) ? { estimate: deadlineEstimateOf(ed.estimate) } : {}),
        source: String(ed.source ?? ""),
      });
    }
    editions.sort((a, b) => a.year - b.year);
    let link = String(conf.link ?? "").trim();
    if (!link) {
      for (const ed of [...editions].reverse()) {
        if (ed.link) {
          link = ed.link;
          break;
        }
      }
    }
    const dblp =
      conf.dblp === null || conf.dblp === undefined || String(conf.dblp).trim() === ""
        ? null
        : String(conf.dblp).trim();
    const upstream_sub =
      conf.upstream_sub !== null && conf.upstream_sub !== undefined
        ? String(conf.upstream_sub).trim()
        : conf.sub !== null && conf.sub !== undefined
          ? String(conf.sub).trim()
          : null;
    out.push({
      key: String(conf.key ?? ""),
      title: String(conf.title ?? ""),
      full_name: String(conf.full_name ?? ""),
      link,
      rank: Object.fromEntries(
        Object.entries((conf.rank as Record<string, unknown> | undefined) ?? {})
          .filter(
            ([, v]) =>
              v !== null &&
              v !== undefined &&
              String(v).trim() !== "" &&
              String(v).trim() !== "null",
          )
          .map(([k, v]) => [String(k).toLowerCase().trim(), String(v).trim()]),
      ),
      dblp,
      upstream_sub,
      tags: toStringArray(conf.tags),
      categories: toStringArray(conf.categories),
      editions,
      sources: toStringArray(conf.sources),
    });
  }
  return out;
}
