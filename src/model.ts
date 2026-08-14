/**
 * Core types, timezone resolution and date parsers.
 *
 * This module is the single place where upstream free-form values are turned
 * into structured data.  Nothing here throws on bad input: unparsable values
 * become `null` and a de-duplicated warning is written to stderr.
 *
 * Ported from scripts/model.py (cfp-radar).
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

export interface Deadline {
  kind: DeadlineKind;
  label: string;
  /** tz-aware, always UTC. */
  at_utc: Date;
  tz_raw: string;
  round: number;
  comment: string | null;
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

export function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY_MS);
}

/** The calendar day of `d` as a UTC midnight. */
export function dateOnly(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

const PAD2 = (n: number): string => String(n).padStart(2, "0");

/** Python's str ordering: code-point order, locale-independent. */
export function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 'YYYY-MM-DD' in UTC. */
export function fmtDate(d: Date): string {
  return `${d.getUTCFullYear()}-${PAD2(d.getUTCMonth() + 1)}-${PAD2(d.getUTCDate())}`;
}

/** strftime subset: %Y %m %d %H %M %S (UTC). */
export function fmtUTC(d: Date, pattern: string): string {
  return pattern
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
export function slug(title: string): string {
  return (title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// --------------------------------------------------------------------------
// timezone
// --------------------------------------------------------------------------

const TZ_FIXED: Record<string, number> = {
  "": 0,
  utc: 0,
  gmt: 0,
  ut: 0,
  z: 0,
  aoe: AOE_OFFSET_MINUTES,
};

const TZ_NAMED: Record<string, string> = {
  pt: "America/Los_Angeles",
  pst: "America/Los_Angeles",
  pdt: "America/Los_Angeles",
  et: "America/New_York",
  est: "America/New_York",
  edt: "America/New_York",
  cet: "Europe/Paris",
  cest: "Europe/Paris",
};

const TZ_OFFSET_RE = /^(?:utc|gmt)?\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/;

export type Tz = { kind: "fixed"; offsetMinutes: number } | { kind: "iana"; name: string };

/** Map an upstream timezone string to a tz descriptor. Unknown values -> UTC. */
export function resolveTz(tzRaw: string | null | undefined): Tz {
  if (tzRaw === null || tzRaw === undefined) return { kind: "fixed", offsetMinutes: 0 };
  const raw = String(tzRaw).trim();
  const low = raw.toLowerCase();

  if (low in TZ_FIXED) return { kind: "fixed", offsetMinutes: TZ_FIXED[low] };
  if (low in TZ_NAMED) return { kind: "iana", name: TZ_NAMED[low] };

  const m = TZ_OFFSET_RE.exec(low);
  if (m) {
    const sign = m[1] === "-" ? -1 : 1;
    const hours = Number(m[2]);
    const minutes = Number(m[3] ?? 0);
    return { kind: "fixed", offsetMinutes: sign * (hours * 60 + minutes) };
  }

  if (raw.includes("/")) {
    try {
      // Intl throws RangeError for unknown timezone names.
      new Intl.DateTimeFormat("en-US", { timeZone: raw });
      return { kind: "iana", name: raw };
    } catch {
      warn(`unknown IANA timezone ${JSON.stringify(raw)}; using UTC`);
      return { kind: "fixed", offsetMinutes: 0 };
    }
  }

  warn(`unknown timezone ${JSON.stringify(raw)}; using UTC`);
  return { kind: "fixed", offsetMinutes: 0 };
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
}

/** 'YYYY-MM-DD[ HH:MM[:SS]]' (after 'T' -> ' ' and trailing 'Z' stripping). */
function parseNaive(s: string): Naive | null {
  let m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (m) {
    return validTime(+m[4], +m[5], +m[6])
      ? { y: +m[1], m: +m[2], d: +m[3], h: +m[4], min: +m[5], s: +m[6] }
      : null;
  }
  m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(s);
  if (m) {
    return validTime(+m[4], +m[5], 0)
      ? { y: +m[1], m: +m[2], d: +m[3], h: +m[4], min: +m[5], s: 0 }
      : null;
  }
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    return { y: +m[1], m: +m[2], d: +m[3], h: 23, min: 59, s: 59 };
  }
  return null;
}

/** Reject out-of-range wall-clock time components (00:00–23:59:59). */
function validTime(h: number, min: number, s: number): boolean {
  return h <= 23 && min <= 59 && s <= 59;
}

function naiveToMs(n: Naive): number | null {
  const ms = Date.UTC(n.y, n.m - 1, n.d, n.h, n.min, n.s);
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
  return applyTz(ms, resolveTz(tzRaw));
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

const TOKEN_RE = /([A-Za-z]+)|(\d{1,4})/g;

function monthOf(word: string): number | null {
  const w = word.toLowerCase();
  if (w.length < 3) return null;
  for (let i = 0; i < MONTHS.length; i++) {
    if (MONTHS[i].startsWith(w)) return i + 1;
    // Upstream typos such as 'Septemper' (APWeb-WAIM 2024).
    if (w.length >= 4 && MONTHS[i].startsWith(w.slice(0, 4))) return i + 1;
  }
  return null;
}

/** Pull the first month / day / year out of one side of a range. */
function scan(part: string): { month: number | null; day: number | null; year: number | null } {
  let month: number | null = null;
  let day: number | null = null;
  let year: number | null = null;
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
      }
    }
  }
  return { month, day, year };
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

/**
 * Parse free-form event dates such as 'September 29 - October 3, 2025'.
 * Also accepts month-only forms: 'November, 2026', 'March-April, 2025',
 * 'August 2027 (exact dates TBD)'.
 */
export function parseDateRange(
  text: string | null | undefined,
  fallbackYear: number,
): [Date | null, Date | null] {
  if (!text) return [null, null];

  let s = String(text).replace(/[\u2010-\u2015\u2212]/g, "-");
  s = s.replace(/\s+/g, " ").trim();
  // Drop trailing notes that only say the day is unknown.
  s = s.replace(/\s*\([^)]*\bTBD\b[^)]*\)\s*$/i, "").trim();
  // 'September 29 to October 2, 2026' spells the range in words.
  s = s.replace(/\s+(?:to|through|until)\s+/gi, "-");
  const [left, right] = s.split("-", 2);
  const parts = right === undefined ? [left] : [left, right];

  const m1 = scan(parts[0]);
  if (parts.length === 1) {
    if (m1.month === null) {
      warn(`unparsable event date ${JSON.stringify(String(text))}`);
      return [null, null];
    }
    const year = m1.year ?? fallbackYear;
    if (m1.day === null) {
      // Month-only: 'November, 2026' / 'Oct, 2022'.
      return monthSpan(year, m1.month);
    }
    const one = mkdate(year, m1.month, m1.day);
    return one ? [one, one] : [null, null];
  }

  const m2 = scan(parts[1]);
  const m1m = m1.month ?? m2.month;
  const m2m = m2.month ?? m1m;
  if (m1m === null || m2m === null) {
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
      y1 = y2 ?? fallbackYear;
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
const CAMERA = new Set(["camera_ready", "revision_deadline"]);
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
  if (CAMERA.has(s)) return "camera_ready";
  if (s === "rebuttal_start") return "rebuttal_start";
  if (REBUTTAL_END.has(s)) return "rebuttal_end";
  if (s === "review_release") return "review_release";
  if (REGISTRATION.has(s)) return "registration";
  return "other";
}

const ROUND_IN_LABEL = /\bround\s*([0-9]+)/i;

/** Submission round stated in a free-form label, else `default`. */
export function roundOf(label: string | null | undefined, defaultRound = 1): number {
  const match = ROUND_IN_LABEL.exec(String(label ?? ""));
  if (match) {
    const value = Number(match[1]);
    if (value >= 1) return value;
  }
  return defaultRound;
}

// --------------------------------------------------------------------------
// snapshot restore (SPEC.md section 6: keep building when upstream is down)
// --------------------------------------------------------------------------

/** Rebuild conferences from a `data.json`-shaped payload. */
export function conferencesFromJson(payload: Record<string, unknown>): Conference[] {
  const out: Conference[] = [];
  for (const raw of (payload.conferences as unknown[] | undefined) ?? []) {
    const conf = raw as Record<string, unknown>;
    const editions: Edition[] = [];
    for (const edRaw of (conf.editions as unknown[] | undefined) ?? []) {
      const ed = edRaw as Record<string, unknown>;
      const deadlines: Deadline[] = [];
      for (const dlRaw of (ed.deadlines as unknown[] | undefined) ?? []) {
        const dl = dlRaw as Record<string, unknown>;
        const at = parseInstant(dl.utc, "UTC");
        if (at === null) continue;
        deadlines.push({
          kind: kindOf(String(dl.kind ?? "other")),
          label: String(dl.label ?? ""),
          at_utc: at,
          tz_raw: String(dl.tz_raw ?? ""),
          round: Number(dl.round ?? 1) || 1,
          comment: dl.comment === null || dl.comment === undefined ? null : String(dl.comment),
        });
      }
      editions.push({
        year: Number(ed.year),
        edition_id: String(ed.id ?? ""),
        link: String(ed.link ?? ""),
        place: String(ed.place ?? ""),
        date_text: String(ed.date_text ?? ""),
        event_start: asDate(ed.event_start),
        event_end: asDate(ed.event_end),
        deadlines,
        estimated: Boolean(ed.estimated),
        source: String(ed.source ?? ""),
      });
    }
    out.push({
      key: String(conf.key ?? ""),
      title: String(conf.title ?? ""),
      full_name: String(conf.full_name ?? ""),
      link: String(conf.link ?? ""),
      rank: Object.fromEntries(
        Object.entries((conf.rank as Record<string, unknown> | undefined) ?? {}).map(([k, v]) => [
          String(k),
          String(v),
        ]),
      ),
      dblp: null,
      upstream_sub: null,
      tags: ((conf.tags as unknown[] | undefined) ?? []).map((t) => String(t)),
      categories: ((conf.categories as unknown[] | undefined) ?? []).map((c) => String(c)),
      editions,
      sources: ((conf.sources as unknown[] | undefined) ?? []).map((s) => String(s)),
    });
  }
  return out;
}
