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
const ABSTRACT_KEYS = ["abstract_deadline", "abstract deadline", "abstract"];
const PAPER_KEYS = [
  "deadline",
  "paper_deadline",
  "submission_deadline",
  "paper deadline",
  "submission deadline",
];
const NOTIFICATION_KEYS = ["notification_deadline", "notification deadline", "notification"];
const CAMERA_READY_KEYS = [
  "camera_ready_deadline",
  "camera ready deadline",
  "camera_ready",
  "final_deadline",
];

function extractCandidate(rec: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (rec[key] !== null && rec[key] !== undefined && String(rec[key]).trim() !== "") {
      return rec[key];
    }
  }
  return null;
}

export function deadlinesOf(
  timeline: unknown,
  tzRaw: string,
  rawEdition?: Record<string, unknown>,
): Deadline[] {
  const out: Deadline[] = [];
  if (Array.isArray(timeline) && timeline.length > 0) {
    for (const [index, entry] of timeline.entries()) {
      if (typeof entry !== "object" || entry === null) continue;
      const rec = entry as Record<string, unknown>;
      const rnd = index + 1;
      const entryTz = String(rec.timezone ?? rec.tz ?? tzRaw ?? "");
      const comment =
        rec.comment === null || rec.comment === undefined ? null : String(rec.comment);
      const rawAbstract = extractCandidate(rec, ABSTRACT_KEYS);
      const rawPaper = extractCandidate(rec, PAPER_KEYS);
      const rawNotification = extractCandidate(rec, NOTIFICATION_KEYS);
      const rawCameraReady = extractCandidate(rec, CAMERA_READY_KEYS);
      const candidates: Array<[DeadlineKind, string, unknown]> = [
        ["abstract", "Abstract submission", rawAbstract],
        ["paper", "Paper submission", rawPaper],
        ["notification", "Notification", rawNotification],
        ["camera_ready", "Camera-ready", rawCameraReady],
      ];
      for (const [kind, label, raw] of candidates) {
        if (raw === null || raw === undefined) continue;
        const at = parseInstant(raw, entryTz);
        if (at === null) continue;
        out.push({ kind, label, at_utc: at, tz_raw: entryTz, round: rnd, comment });
      }
    }
    if (out.length > 0) return out;
  }

  // Fallback to top-level rawEdition properties if timeline is absent or yielded no deadlines
  if (rawEdition && typeof rawEdition === "object") {
    const entryTz = String(rawEdition.timezone ?? rawEdition.tz ?? tzRaw ?? "");
    const comment =
      rawEdition.comment === null || rawEdition.comment === undefined
        ? null
        : String(rawEdition.comment);
    const rawAbstract = extractCandidate(rawEdition, ABSTRACT_KEYS);
    const rawPaper = extractCandidate(rawEdition, PAPER_KEYS);
    const rawNotification = extractCandidate(rawEdition, NOTIFICATION_KEYS);
    const rawCameraReady = extractCandidate(rawEdition, CAMERA_READY_KEYS);
    const candidates: Array<[DeadlineKind, string, unknown]> = [
      ["abstract", "Abstract submission", rawAbstract],
      ["paper", "Paper submission", rawPaper],
      ["notification", "Notification", rawNotification],
      ["camera_ready", "Camera-ready", rawCameraReady],
    ];
    for (const [kind, label, raw] of candidates) {
      if (raw === null || raw === undefined) continue;
      const at = parseInstant(raw, entryTz);
      if (at === null) continue;
      out.push({ kind, label, at_utc: at, tz_raw: entryTz, round: 1, comment });
    }
  }

  return out;
}

export function editionOf(raw: Record<string, unknown>, parentTz = ""): Edition | null {
  const year = Number(raw.year);
  if (!Number.isInteger(year) || year <= 0) {
    warn(`ccfddl edition without a usable year: ${JSON.stringify(raw.id)}`);
    return null;
  }
  const tzRaw = String(raw.timezone ?? raw.tz ?? parentTz ?? "");
  const dateText = String(raw.date ?? "");
  const [start, end] = parseDateRange(dateText, year);
  return {
    year,
    edition_id: String(raw.id ?? (year ? String(year) : "")),
    link: String(raw.link ?? ""),
    place: String(raw.place ?? ""),
    date_text: dateText,
    event_start: start,
    event_end: end,
    deadlines: deadlinesOf(raw.timeline, tzRaw, raw),
    estimated: false,
    source: NAME,
  };
}

export function conferenceOf(raw: Record<string, unknown>): Conference | null {
  const title = String(raw.title ?? "").trim();
  if (!title) return null;
  const parentTz = String(raw.timezone ?? raw.tz ?? "");
  const editions = ((raw.confs as unknown[] | null) ?? [])
    .map((c) =>
      typeof c === "object" && c !== null
        ? editionOf(c as Record<string, unknown>, parentTz)
        : null,
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
    let entries: string[];
    try {
      entries = readdirSync(cur);
    } catch {
      continue;
    }
    for (const name of entries) {
      const p = join(cur, name);
      try {
        if (statSync(p).isDirectory()) {
          stack.push(p);
        } else if (
          (name.endsWith(".yml") || name.endsWith(".yaml")) &&
          name !== "types.yml" &&
          name !== "types.yaml"
        ) {
          files.push(p);
        }
      } catch {
        continue;
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
