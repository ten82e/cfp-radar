/**
 * huggingface/ai-deadlines source.
 * Ported from scripts/sources/aideadlines.py.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
import { fetchTarball } from "./base.ts";

export const REPO = "huggingface/ai-deadlines";
export const REF = "main";
export const NAME = "aideadlines";

// Old-format editions carry the deadlines at the top level.
const LEGACY: Array<[DeadlineKind, string, string]> = [
  ["abstract", "Abstract submission", "abstract_deadline"],
  ["paper", "Paper submission", "deadline"],
  ["paper", "Paper submission", "paper_deadline"],
  ["notification", "Notification", "notification_deadline"],
  ["notification", "Notification", "notification"],
  ["camera_ready", "Camera-ready submission", "camera_ready_deadline"],
  ["camera_ready", "Camera-ready submission", "camera_ready"],
];

/** Rewrite a lone previous-year token in free text to the edition year. */
function liftStaleYear(dateText: string, year: number): string {
  const found = [...dateText.matchAll(/\b(20\d{2})\b/g)].map((m) => Number(m[1]));
  if (found.length > 0 && found.every((y) => y === year - 1)) {
    return dateText.replace(new RegExp(`\\b${year - 1}\\b`, "g"), String(year));
  }
  return dateText;
}

/** 'CCF: A, CORE: A*, THCPL: A' or { ccf: 'A', core: 'A*' } -> {ccf: 'A', core: 'A*', ...}. */
export function rankOf(rankings: unknown): Record<string, string> {
  const rank: Record<string, string> = {};
  if (!rankings) return rank;

  if (typeof rankings === "object") {
    if (Array.isArray(rankings)) {
      for (const item of rankings) {
        if (typeof item === "string") {
          const idx = item.indexOf(":");
          if (idx >= 0) {
            const name = item.slice(0, idx).trim();
            const value = item.slice(idx + 1).trim();
            if (name && value) rank[name.toLowerCase()] = value;
          }
        } else if (typeof item === "object" && item !== null) {
          for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
            if (v !== null && v !== undefined && String(v).trim()) {
              rank[k.toLowerCase().trim()] = String(v).trim();
            }
          }
        }
      }
      return rank;
    }
    for (const [k, v] of Object.entries(rankings as Record<string, unknown>)) {
      if (v !== null && v !== undefined && String(v).trim()) {
        rank[k.toLowerCase().trim()] = String(v).trim();
      }
    }
    return rank;
  }

  for (const chunk of String(rankings).split(",")) {
    const idx = chunk.indexOf(":");
    if (idx >= 0) {
      const name = chunk.slice(0, idx).trim();
      const value = chunk.slice(idx + 1).trim();
      if (name && value) rank[name.toLowerCase()] = value;
    }
  }
  return rank;
}

export function deadlinesOf(raw: Record<string, unknown>): Deadline[] {
  const out: Deadline[] = [];
  const parentTz = String(raw.timezone ?? raw.tz ?? "");
  const entries = raw.deadlines;
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue;
      const rec = entry as Record<string, unknown>;
      const tzRaw = String(rec.timezone ?? rec.tz ?? parentTz);
      const at = parseInstant(rec.date, tzRaw);
      if (at === null) continue;
      const rawType = String(rec.type ?? rec.kind ?? "");
      const label = String(rec.label ?? rawType);
      out.push({
        kind: kindOf(rawType),
        label,
        at_utc: at,
        tz_raw: tzRaw,
        // This schema has no round field; the label is the only place a round
        // is ever stated (SPEC.md 3.3).
        round: roundOf(label),
        comment: rec.comment === null || rec.comment === undefined ? null : String(rec.comment),
      });
    }
    if (out.length > 0) return out;
  }

  for (const [kind, label, key] of LEGACY) {
    const at = parseInstant(raw[key], parentTz);
    if (at !== null) {
      out.push({ kind, label, at_utc: at, tz_raw: parentTz, round: 1, comment: null });
    }
  }
  return out;
}

export function editionOf(raw: Record<string, unknown>): Edition | null {
  const year = Number(raw.year);
  if (!Number.isInteger(year) || year <= 0) {
    warn(`aideadlines edition without a usable year: ${JSON.stringify(raw.id)}`);
    return null;
  }
  const dateText = liftStaleYear(String(raw.date ?? ""), year);
  let start = asDate(raw.start);
  let end = asDate(raw.end);
  const [parsedStart, parsedEnd] = parseDateRange(dateText, year);
  // Structured start/end is sometimes a full year off while the free-text
  // date names the edition year (ICASSP 2026: start 2025-05-04, date May 2026).
  if (
    parsedStart !== null &&
    parsedEnd !== null &&
    parsedStart.getUTCFullYear() === year &&
    (start === null || end === null || start.getUTCFullYear() !== year)
  ) {
    start = parsedStart;
    end = parsedEnd;
  } else {
    start = start ?? parsedStart;
    end = end ?? parsedEnd;
  }
  const rawPlace = raw.place !== null && raw.place !== undefined ? String(raw.place).trim() : "";
  const place =
    rawPlace ||
    ["city", "country"]
      .map((k) => (raw[k] !== null && raw[k] !== undefined ? String(raw[k]).trim() : ""))
      .filter((s) => s.length > 0)
      .join(", ");
  return {
    year,
    edition_id: String(raw.id ?? (year ? String(year) : "")),
    link: String(raw.link ?? ""),
    place,
    date_text: dateText,
    event_start: start,
    event_end: end,
    deadlines: deadlinesOf(raw),
    estimated: false,
    source: NAME,
  };
}

/** Read `src/data/conferences/*.yml`; each item is one edition. */
export function parseTree(conferencesDir: string): Conference[] {
  const byKey = new Map<string, Conference>();
  let fileList: string[];
  try {
    fileList = readdirSync(conferencesDir);
  } catch {
    return [];
  }
  for (const path of fileList.filter((n) => n.endsWith(".yml") || n.endsWith(".yaml")).sort()) {
    let loaded: unknown;
    try {
      loaded = loadYaml(readFileSync(join(conferencesDir, path), "utf8"));
    } catch (exc) {
      warn(`aideadlines: cannot parse ${path}: ${String(exc)}`);
      continue;
    }
    const items = Array.isArray(loaded) ? loaded : [loaded];
    for (const item of items) {
      if (typeof item !== "object" || item === null) continue;
      const raw = item as Record<string, unknown>;
      const title = String(raw.title ?? "").trim();
      if (!title) continue;
      const edition = editionOf(raw);
      if (edition === null) continue;
      const key = slug(title);
      let conference = byKey.get(key);
      if (conference === undefined) {
        conference = {
          key,
          title,
          full_name: String(raw.full_name ?? title),
          link: "",
          rank: {},
          dblp: null,
          upstream_sub: null,
          tags: ((raw.tags as unknown[] | null) ?? []).map((t) => String(t)),
          categories: [],
          editions: [],
          sources: [NAME],
        };
        byKey.set(key, conference);
      }
      conference.editions.push(edition);
      // Conference-level facts come from the newest edition seen.
      if (edition.year >= Math.max(...conference.editions.map((e) => e.year))) {
        conference.full_name = String(raw.full_name ?? title);
        const rank = rankOf(raw.rankings);
        if (Object.keys(rank).length > 0) conference.rank = rank;
        if (edition.link) conference.link = edition.link;
        const tags = ((raw.tags as unknown[] | null) ?? []).map((t) => String(t));
        if (tags.length > 0) conference.tags = tags;
      }
    }
  }
  for (const conference of byKey.values()) {
    conference.editions.sort((a, b) => a.year - b.year);
  }
  return [...byKey.keys()].sort().map((k) => byKey.get(k)!);
}

export class AideadlinesSource {
  name = NAME;

  async load(cacheDir: string, options: { offline?: boolean } = {}): Promise<Conference[]> {
    const root = await fetchTarball(REPO, REF, cacheDir, options);
    return parseTree(join(root, "src", "data", "conferences"));
  }
}
