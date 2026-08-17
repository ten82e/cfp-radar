/**
 * Local source: conferences the upstreams do not carry (data/extra.yaml).
 * Ported from scripts/sources/local.py.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { load as loadYaml } from "js-yaml";
import {
  asDate,
  type Conference,
  type Deadline,
  type DeadlineKind,
  type Edition,
  kindOf,
  parseDateRange,
  parseInstant,
  roundOf,
  slug,
  warn,
} from "../model.ts";

export const NAME = "local";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DEFAULT_PATH = join(ROOT, "data", "extra.yaml");

const LEGACY_KIND_KEYS: Array<[DeadlineKind, string, string[]]> = [
  ["abstract", "Abstract submission", ["abstract_deadline", "abstract"]],
  [
    "paper",
    "Paper submission",
    ["deadline", "paper_deadline", "submission_deadline", "submission"],
  ],
  ["notification", "Notification", ["notification_deadline", "notification"]],
  [
    "camera_ready",
    "Camera-ready",
    ["camera_ready_deadline", "camera_ready", "final_deadline", "final_paper", "final_submission"],
  ],
  ["rebuttal_start", "Rebuttal start", ["rebuttal_start", "rebuttal_start_deadline"]],
  ["rebuttal_end", "Rebuttal end", ["rebuttal_end", "rebuttal_deadline", "rebuttal_end_deadline"]],
  ["registration", "Registration", ["registration_deadline", "registration"]],
];

export function deadlinesOf(raw: Record<string, unknown> | null | undefined): Deadline[] {
  if (!raw || typeof raw !== "object") return [];
  const out: Deadline[] = [];
  const parentTz = String(raw.tz ?? raw.timezone ?? "");
  for (const entry of (raw.deadlines as unknown[] | null) ?? []) {
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const tzRaw = String(rec.tz ?? rec.timezone ?? parentTz);
    const at = parseInstant(rec.date, tzRaw);
    if (at === null) continue;
    const kind = kindOf(String(rec.kind ?? rec.type ?? ""));
    const label = String(rec.label ?? kind);
    out.push({
      kind,
      label,
      at_utc: at,
      tz_raw: tzRaw,
      // A round named in the label wins over the explicit field.
      round: roundOf(label, Number(rec.round ?? 1) || 1),
      comment: rec.comment === null || rec.comment === undefined ? null : String(rec.comment),
    });
  }
  if (out.length === 0) {
    for (const [kind, label, keys] of LEGACY_KIND_KEYS) {
      for (const key of keys) {
        const val = raw[key];
        if (typeof val === "string" && val.trim()) {
          const at = parseInstant(val, parentTz);
          if (at !== null) {
            out.push({
              kind,
              label,
              at_utc: at,
              tz_raw: parentTz,
              round: roundOf(label, 1),
              comment: null,
            });
            break;
          }
        }
      }
    }
  }
  return out;
}

export function editionOf(
  raw: Record<string, unknown> | null | undefined,
  key: string,
): Edition | null {
  if (!raw || typeof raw !== "object") return null;
  const year = Number(raw.year);
  if (!Number.isInteger(year) || year <= 0) {
    warn(`local edition without a usable year under ${JSON.stringify(key)}`);
    return null;
  }
  const dateText = String(raw.date_text ?? raw.date ?? "");
  let start = asDate(raw.event_start ?? raw.start);
  let end = asDate(raw.event_end ?? raw.end);
  if (start === null || end === null) {
    const [parsedStart, parsedEnd] = parseDateRange(dateText, year);
    start = start ?? parsedStart;
    end = end ?? parsedEnd;
  }
  return {
    year,
    edition_id: String(raw.id ?? `${key}${String(year % 100).padStart(2, "0")}`),
    link: String(raw.link ?? ""),
    place: String(raw.place ?? ""),
    date_text: dateText,
    event_start: start,
    event_end: end,
    deadlines: deadlinesOf(raw),
    estimated: Boolean(raw.estimated),
    source: NAME,
  };
}

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

/** Parse an extra.yaml file into conferences. */
export function parseFile(path: string | null | undefined): Conference[] {
  if (!path) return [];
  let loaded: unknown;
  try {
    loaded = loadYaml(readFileSync(path, "utf8"));
  } catch (exc) {
    warn(`local: cannot parse ${path}: ${String(exc)}`);
    return [];
  }
  const conferences =
    typeof loaded === "object" && loaded !== null
      ? (((loaded as Record<string, unknown>).conferences as unknown[] | null) ?? [])
      : [];
  const out: Conference[] = [];
  for (const item of conferences) {
    if (typeof item !== "object" || item === null) continue;
    const raw = item as Record<string, unknown>;
    const title = String(raw.title ?? "").trim();
    const key = String(raw.key ?? slug(title)).trim();
    if (!key) {
      warn(`local source: entry without key or title in ${path}`);
      continue;
    }
    const editions = ((raw.editions as unknown[] | null) ?? [])
      .map((e) =>
        typeof e === "object" && e !== null ? editionOf(e as Record<string, unknown>, key) : null,
      )
      .filter((e): e is Edition => e !== null)
      .sort((a, b) => a.year - b.year);
    const rank: Record<string, string> = {};
    for (const [k, v] of Object.entries((raw.rank as Record<string, unknown> | null) ?? {})) {
      if (v !== null && v !== undefined && String(v).trim() !== "" && String(v).trim() !== "null") {
        rank[String(k).toLowerCase().trim()] = String(v).trim();
      }
    }
    let link = String(raw.link ?? "").trim();
    if (!link) {
      for (const edition of [...editions].reverse()) {
        if (edition.link) {
          link = edition.link;
          break;
        }
      }
    }
    out.push({
      key,
      title: title || key,
      full_name: String(raw.full_name ?? "") || title || key,
      link,
      rank,
      dblp: raw.dblp === null || raw.dblp === undefined ? null : String(raw.dblp),
      upstream_sub: null,
      tags: toStringArray(raw.tags),
      categories: toStringArray(raw.categories),
      editions,
      sources: [NAME],
    });
  }
  return out;
}

export class LocalSource {
  name = NAME;
  readonly path: string;

  constructor(path: string = DEFAULT_PATH) {
    this.path = path;
  }

  async load(): Promise<Conference[]> {
    return parseFile(this.path);
  }
}
