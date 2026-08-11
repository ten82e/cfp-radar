/**
 * ccfddl/ccf-deadlines source.
 * Ported from scripts/sources/ccfddl.py.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import {
  type Conference,
  type Deadline,
  type DeadlineKind,
  type Edition,
  parseDateRange,
  parseInstant,
  slug,
  warn,
} from "../model.ts";
import { fetchTarball } from "./base.ts";

export const REPO = "ccfddl/ccf-deadlines";
export const REF = "main";
export const NAME = "ccfddl";

// 'abstract deadline' (with a space) exists once upstream.
const ABSTRACT_KEYS = ["abstract_deadline", "abstract deadline"];

function deadlinesOf(timeline: unknown, tzRaw: string): Deadline[] {
  const out: Deadline[] = [];
  for (const [index, entry] of ((timeline as unknown[] | null) ?? []).entries()) {
    if (typeof entry !== "object" || entry === null) continue;
    const rec = entry as Record<string, unknown>;
    const rnd = index + 1;
    const comment = rec.comment === null || rec.comment === undefined ? null : String(rec.comment);
    let rawAbstract: unknown = null;
    for (const key of ABSTRACT_KEYS) {
      if (rec[key] !== null && rec[key] !== undefined) {
        rawAbstract = rec[key];
        break;
      }
    }
    const candidates: Array<[DeadlineKind, string, unknown]> = [
      ["abstract", "Abstract submission", rawAbstract],
      ["paper", "Paper submission", rec.deadline],
    ];
    for (const [kind, label, raw] of candidates) {
      if (raw === null || raw === undefined) continue;
      const at = parseInstant(raw, tzRaw);
      if (at === null) continue;
      out.push({ kind, label, at_utc: at, tz_raw: tzRaw, round: rnd, comment });
    }
  }
  return out;
}

function editionOf(raw: Record<string, unknown>): Edition | null {
  const year = Number(raw.year);
  if (!Number.isInteger(year) || year <= 0) {
    warn(`ccfddl edition without a usable year: ${JSON.stringify(raw.id)}`);
    return null;
  }
  const tzRaw = String(raw.timezone ?? "");
  const dateText = String(raw.date ?? "");
  const [start, end] = parseDateRange(dateText, year);
  return {
    year,
    edition_id: String(raw.id ?? ""),
    link: String(raw.link ?? ""),
    place: String(raw.place ?? ""),
    date_text: dateText,
    event_start: start,
    event_end: end,
    deadlines: deadlinesOf(raw.timeline, tzRaw),
    estimated: false,
    source: NAME,
  };
}

function conferenceOf(raw: Record<string, unknown>): Conference | null {
  const title = String(raw.title ?? "").trim();
  if (!title) return null;
  const editions = ((raw.confs as unknown[] | null) ?? [])
    .map((c) =>
      typeof c === "object" && c !== null ? editionOf(c as Record<string, unknown>) : null,
    )
    .filter((e): e is Edition => e !== null)
    .sort((a, b) => a.year - b.year);
  const rank: Record<string, string> = {};
  for (const [k, v] of Object.entries((raw.rank as Record<string, unknown> | null) ?? {})) {
    if (v !== null && v !== undefined) rank[String(k).toLowerCase()] = String(v);
  }
  let link = "";
  for (const edition of [...editions].reverse()) {
    if (edition.link) {
      link = edition.link;
      break;
    }
  }
  return {
    key: slug(title),
    title,
    full_name: String(raw.description ?? title),
    link,
    rank,
    dblp: raw.dblp === null || raw.dblp === undefined ? null : String(raw.dblp),
    upstream_sub: raw.sub === null || raw.sub === undefined ? null : String(raw.sub),
    tags: [],
    categories: [],
    editions,
    sources: [NAME],
  };
}

/** Read every `conference/<SUB>/<name>.yml` under an extracted tree. */
export function parseTree(conferenceDir: string): Conference[] {
  const out: Conference[] = [];
  const files: string[] = [];
  const stack = [conferenceDir];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === undefined) break;
    for (const name of readdirSync(cur)) {
      const p = join(cur, name);
      if (statSync(p).isDirectory()) {
        stack.push(p);
      } else if (name.endsWith(".yml") && name !== "types.yml") {
        files.push(p);
      }
    }
  }
  for (const path of files.sort()) {
    let loaded: unknown;
    try {
      loaded = loadYaml(readFileSync(path, "utf8"));
    } catch (exc) {
      warn(`ccfddl: cannot parse ${path}: ${String(exc)}`);
      continue;
    }
    const items = Array.isArray(loaded) ? loaded : [loaded];
    for (const item of items) {
      if (typeof item !== "object" || item === null) continue;
      const conference = conferenceOf(item as Record<string, unknown>);
      if (conference !== null) out.push(conference);
    }
  }
  return out;
}

export class CcfddlSource {
  name = NAME;

  async load(cacheDir: string, options: { offline?: boolean } = {}): Promise<Conference[]> {
    const root = await fetchTarball(REPO, REF, cacheDir, options);
    return parseTree(join(root, "conference"));
  }
}
