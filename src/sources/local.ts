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

export function deadlinesOf(raw: Record<string, unknown>): Deadline[] {
  const out: Deadline[] = [];
  for (const entry of (raw.deadlines as unknown[] | null) ?? []) {
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const tzRaw = String(rec.tz ?? rec.timezone ?? "");
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
  return out;
}

function editionOf(raw: Record<string, unknown>, key: string): Edition | null {
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
    estimated: false,
    source: NAME,
  };
}

/** Read data/extra.yaml.  A missing file yields an empty list. */
export function parseFile(path: string): Conference[] {
  let loaded: unknown;
  try {
    loaded = loadYaml(readFileSync(path, "utf8")) ?? {};
  } catch (exc) {
    warn(`local source: cannot parse ${path}: ${String(exc)}`);
    return [];
  }
  if (typeof loaded !== "object" || loaded === null) return [];

  const out: Conference[] = [];
  for (const item of ((loaded as Record<string, unknown>).conferences as unknown[] | null) ?? []) {
    if (typeof item !== "object" || item === null) continue;
    const raw = item as Record<string, unknown>;
    const title = String(raw.title ?? "").trim();
    const key = String(raw.key ?? slug(title));
    if (!key) {
      warn(`local source: entry without key or title in ${path}`);
      continue;
    }
    const editions = ((raw.editions as unknown[] | null) ?? [])
      .map((c) =>
        typeof c === "object" && c !== null ? editionOf(c as Record<string, unknown>, key) : null,
      )
      .filter((e): e is Edition => e !== null)
      .sort((a, b) => a.year - b.year);
    const rank: Record<string, string> = {};
    for (const [k, v] of Object.entries((raw.rank as Record<string, unknown> | null) ?? {})) {
      rank[String(k).toLowerCase()] = String(v);
    }
    out.push({
      key,
      title: title || key,
      full_name: String(raw.full_name ?? "") || title || key,
      link: String(raw.link ?? ""),
      rank,
      dblp: raw.dblp === null || raw.dblp === undefined ? null : String(raw.dblp),
      upstream_sub: null,
      tags: ((raw.tags as unknown[] | null) ?? []).map((t) => String(t)),
      categories: ((raw.categories as unknown[] | null) ?? []).map((c) => String(c)),
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
