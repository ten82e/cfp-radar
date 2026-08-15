/**
 * Name matching, classification, overrides, roll-forward and selection.
 * Ported from scripts/merge.py (cfp-radar).  Consumes the frozen interface
 * of src/model.ts (SPEC.md section 3) only.
 */

import {
  addDays,
  asDate,
  type Conference,
  cmpStr,
  DAY_MS,
  type Deadline,
  dateOnly,
  type Edition,
} from "./model.ts";
import { deadlinesOf } from "./sources/local.ts";

export const DEFAULT_SOURCE_PRIORITY = ["local", "aideadlines", "ccfddl"];
export const DEFAULT_ONE_TO_ONE_MAX_S = 604800; // 7 d
export const DEFAULT_CROSS_SOURCE_TOLERANCE_S = 90000; // 25 h
export const ABSENT_RANKS = new Set(["N", "-", "none", "None", "NONE", "null", "NULL", ""]);

interface Windows {
  one_to_one: number;
  cross_source: number;
}

// --------------------------------------------------------------------------
// merge
// --------------------------------------------------------------------------

/** Rewrite conference keys before name matching (SPEC.md 3.1). */
export function applyAliases(
  groups: Conference[][],
  aliases: Record<string, unknown> | null | undefined,
): Conference[][] {
  if (!aliases) return groups;
  const table = new Map(Object.entries(aliases).map(([k, v]) => [k, String(v)]));
  return groups.map((group) =>
    group.map((conf) => {
      const key = table.get(conf.key);
      return key === undefined ? conf : { ...conf, key };
    }),
  );
}

export interface MergeStats {
  merged_deadlines: number;
  merged_by_key: Record<string, number>;
}

function freshStats(): MergeStats {
  return { merged_deadlines: 0, merged_by_key: {} };
}

/** Merge per-source conference lists into one list keyed by `Conference.key`. */
export function mergeSources(
  groups: Conference[][],
  config: Record<string, unknown>,
  stats: MergeStats | null = null,
): Conference[] {
  const priority = (config.source_priority as string[]) ?? DEFAULT_SOURCE_PRIORITY;
  const windows = windowsOf(config);
  const tally = freshStats();

  const ordered: Array<{ prio: number; seq: number; conf: Conference }> = [];
  for (const group of groups) {
    for (const conf of group) {
      ordered.push({ prio: priorityOf(conf, priority), seq: ordered.length, conf });
    }
  }
  ordered.sort((a, b) => a.prio - b.prio || a.seq - b.seq);

  const buckets = new Map<string, Conference[][]>();
  for (const { conf } of ordered) {
    const bucketList = buckets.get(conf.key) ?? [];
    let placed = false;
    for (const bucket of bucketList) {
      if (sameConference(bucket, conf)) {
        bucket.push(conf);
        placed = true;
        break;
      }
    }
    if (!placed) bucketList.push([conf]);
    buckets.set(conf.key, bucketList);
  }

  const merged: Conference[] = [];
  for (const [key, bucketList] of buckets) {
    if (bucketList.length === 1) {
      merged.push(mergeBucket(key, bucketList[0], windows, tally));
      continue;
    }
    const sorted = [...bucketList].sort((a, b) =>
      cmpStr(a[0].upstream_sub ?? "", b[0].upstream_sub ?? ""),
    );
    sorted.forEach((bucket, index) => {
      const suffix = (bucket[0].upstream_sub ?? String(index)).toLowerCase();
      merged.push(mergeBucket(index === 0 ? key : `${key}-${suffix}`, bucket, windows, tally));
    });
  }

  merged.sort((a, b) => cmpStr(a.key, b.key));
  if (stats !== null) {
    stats.merged_deadlines = tally.merged_deadlines;
    stats.merged_by_key = tally.merged_by_key;
  }
  return merged;
}

function windowsOf(config: Record<string, unknown>): Windows {
  return {
    one_to_one: Number(config.deadline_merge_one_to_one_max_seconds ?? DEFAULT_ONE_TO_ONE_MAX_S),
    cross_source: Number(
      config.deadline_merge_cross_source_seconds ?? DEFAULT_CROSS_SOURCE_TOLERANCE_S,
    ),
  };
}

function priorityOf(conf: Conference, priority: string[]): number {
  for (const name of conf.sources) {
    const idx = priority.indexOf(name);
    if (idx >= 0) return idx;
  }
  return priority.length;
}

function sameConference(bucket: Conference[], conf: Conference): boolean {
  for (const existing of bucket) {
    if (existing.upstream_sub && conf.upstream_sub) {
      return existing.upstream_sub === conf.upstream_sub;
    }
  }
  return true;
}

function mergeBucket(
  key: string,
  confs: Conference[],
  windows: Windows,
  tally: MergeStats,
): Conference {
  // `confs` is ordered high priority first.
  const out: Conference = {
    key,
    title: confs[0].title,
    full_name: confs[0].full_name,
    link: confs[0].link,
    rank: {},
    dblp: null,
    upstream_sub: null,
    tags: [],
    categories: [],
    editions: [],
    sources: [],
  };
  for (const conf of [...confs].reverse()) {
    // low priority first, higher priority overwrites
    if (conf.title) out.title = conf.title;
    if (conf.full_name) out.full_name = conf.full_name;
    if (conf.link) out.link = conf.link;
    if (Object.keys(conf.rank).length > 0) out.rank = { ...out.rank, ...conf.rank };
    if (conf.dblp) out.dblp = conf.dblp;
    if (conf.upstream_sub) out.upstream_sub = conf.upstream_sub;
  }
  out.tags = unique(confs.flatMap((c) => c.tags));
  out.categories = unique(confs.flatMap((c) => c.categories));
  out.sources = unique(confs.flatMap((c) => c.sources));
  const before = tally.merged_deadlines;
  out.editions = mergeEditions(confs, windows, tally);
  const mergedHere = tally.merged_deadlines - before;
  if (mergedHere > 0) tally.merged_by_key[key] = mergedHere;
  return out;
}

function mergeEditions(confs: Conference[], windows: Windows, tally: MergeStats): Edition[] {
  const byYear = new Map<number, Array<{ edition: Edition; tagged: Array<[string, Deadline]> }>>();
  for (const conf of confs) {
    // high priority first
    for (const edition of conf.editions) {
      const bucket = byYear.get(edition.year) ?? [];
      const index = mergeTarget(
        bucket.map((b) => b.edition),
        edition,
      );
      const tagged: Array<[string, Deadline]> = edition.deadlines.map((d) => [edition.source, d]);
      if (index === null) {
        bucket.push({ edition: { ...edition, deadlines: [] }, tagged });
      } else {
        const held = bucket[index].edition;
        if (held.estimated && !edition.estimated) {
          // SPEC.md 3.6: a real edition replaces an estimated one.
          bucket[index] = { edition: { ...edition, deadlines: [] }, tagged };
        } else if (edition.estimated && !held.estimated) {
          // An estimate joining a real edition contributes nothing.
          continue;
        } else {
          fillEdition(held, edition);
          bucket[index].tagged.push(...tagged);
        }
      }
      byYear.set(edition.year, bucket);
    }
  }
  const out: Edition[] = [];
  for (const year of [...byYear.keys()].sort((a, b) => a - b)) {
    const bucket = byYear.get(year)!;
    bucket.sort((a, b) => cmpStr(a.edition.edition_id, b.edition.edition_id));
    for (const item of bucket) {
      // Deduplicate after every source has contributed.
      item.edition.deadlines = dedupDeadlines(item.tagged, windows, tally);
      out.push(item.edition);
    }
  }
  return out;
}

function mergeTarget(bucket: Edition[], edition: Edition): number | null {
  for (let i = 0; i < bucket.length; i++) {
    if (bucket[i].edition_id === edition.edition_id) return i;
  }
  for (let i = 0; i < bucket.length; i++) {
    if (bucket[i].source !== edition.source) return i;
  }
  return null;
}

function fillEdition(target: Edition, other: Edition): void {
  if (!target.edition_id && other.edition_id) target.edition_id = other.edition_id;
  if (!target.link && other.link) target.link = other.link;
  if (!target.place && other.place) target.place = other.place;
  if (!target.date_text && other.date_text) target.date_text = other.date_text;
  if (!target.event_start && other.event_start) target.event_start = other.event_start;
  if (!target.event_end && other.event_end) target.event_end = other.event_end;
}

/** Label form used for equality: case and whitespace carry no meaning. */
function normLabel(label: string | null | undefined): string {
  // Python の str.split() 相当: 先頭・末尾の空白も除去される。
  return (label ?? "").trim().split(/\s+/).join(" ").toLowerCase();
}

/** Re-apply the SPEC.md 3.6 fold after roll-forward. */
export function dedupDeadlinesAfterRollforward(
  confs: Conference[],
  config: Record<string, unknown>,
  stats: MergeStats | null = null,
): Conference[] {
  const windows = windowsOf(config);
  const tally = freshStats();
  const out: Conference[] = [];
  for (const conf of confs) {
    const editions: Edition[] = [];
    for (const edition of conf.editions) {
      const before = tally.merged_deadlines;
      const tagged: Array<[string, Deadline]> = edition.deadlines.map((d) => [edition.source, d]);
      editions.push({ ...edition, deadlines: dedupDeadlines(tagged, windows, tally) });
      const folded = tally.merged_deadlines - before;
      if (folded > 0) {
        tally.merged_by_key[conf.key] = (tally.merged_by_key[conf.key] ?? 0) + folded;
      }
    }
    out.push({ ...conf, editions });
  }
  if (stats !== null) {
    stats.merged_deadlines = (stats.merged_deadlines ?? 0) + tally.merged_deadlines;
    for (const [key, count] of Object.entries(tally.merged_by_key)) {
      stats.merged_by_key[key] = (stats.merged_by_key[key] ?? 0) + count;
    }
  }
  return out;
}

/**
 * Fold deadlines of one edition that are the same deadline seen twice
 * (SPEC.md 3.6).  `tagged` arrives highest source priority first.
 */
function dedupDeadlines(
  tagged: Array<[string, Deadline]>,
  windows: Windows,
  tally: MergeStats,
): Deadline[] {
  const heldPerSource = new Map<string, number>();
  for (const [source, d] of tagged) {
    const key = `${source}\u0000${d.kind}`;
    heldPerSource.set(key, (heldPerSource.get(key) ?? 0) + 1);
  }
  const kept: Array<{ origins: Set<string>; deadline: Deadline }> = [];
  for (const [source, deadline] of tagged) {
    let best: { gap: number; index: number } | null = null;
    for (let index = 0; index < kept.length; index++) {
      const { origins, deadline: held } = kept[index];
      if (held.kind !== deadline.kind) continue;
      const gap = Math.abs(held.at_utc.getTime() - deadline.at_utc.getTime()) / 1000;
      if (origins.has(source)) {
        if (gap !== 0 || normLabel(held.label) !== normLabel(deadline.label)) continue;
      } else {
        const oneToOne = [...origins, source].every(
          (name) => (heldPerSource.get(`${name}\u0000${deadline.kind}`) ?? 0) === 1,
        );
        const limit = oneToOne ? windows.one_to_one : windows.cross_source;
        if (gap > limit) continue;
      }
      // Nearest wins, not first.
      if (best === null || gap < best.gap) best = { gap, index };
    }
    if (best === null) {
      kept.push({ origins: new Set([source]), deadline });
      continue;
    }
    const entry = kept[best.index];
    const sameSource = entry.origins.has(source);
    entry.origins.add(source);
    entry.deadline = absorb(entry.deadline, deadline, sameSource);
    tally.merged_deadlines += 1;
  }
  const out = kept.map((k) => k.deadline);
  out.sort(
    (a, b) =>
      a.round - b.round ||
      a.at_utc.getTime() - b.at_utc.getTime() ||
      cmpStr(a.kind, b.kind) ||
      cmpStr(a.label ?? "", b.label ?? ""),
  );
  return out;
}

function absorb(winner: Deadline, loser: Deadline, sameSource: boolean): Deadline {
  const notes: string[] = [];
  if (winner.comment) notes.push(winner.comment);
  if (loser.comment && !notes.includes(loser.comment)) notes.push(loser.comment);
  if (loser.label && loser.label !== winner.label) {
    const sameInstant = winner.at_utc.getTime() === loser.at_utc.getTime();
    const note = `${sameInstant ? "同時刻の" : ""}別記載: ${loser.label}`;
    if (!notes.includes(note)) notes.push(note);
  }
  const comment = notes.length > 0 ? notes.join(" / ") : null;
  const round = sameSource ? winner.round : Math.max(winner.round, loser.round);
  if (comment === winner.comment && round === winner.round) return winner;
  return { ...winner, comment, round };
}

function unique(values: string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}

// --------------------------------------------------------------------------
// classify
// --------------------------------------------------------------------------

export function classify(confs: Conference[], config: Record<string, unknown>): Conference[] {
  const taxonomy = (config.taxonomy as Record<string, unknown>) ?? {};
  const known = new Set(Object.keys((config.categories as Record<string, unknown>) ?? taxonomy));
  const excluded = new Set((config.exclude as string[] | null) ?? []);
  const out: Conference[] = [];
  for (const conf of confs) {
    let categories: string[];
    if (excluded.has(conf.key)) {
      categories = [];
    } else {
      categories = [...conf.categories];
      for (const [name, rule] of Object.entries(taxonomy)) {
        if (!categories.includes(name) && matches(conf, (rule as Record<string, unknown>) ?? {})) {
          categories.push(name);
        }
      }
      categories = known.size === 0 ? categories : categories.filter((c) => known.has(c));
    }
    out.push({ ...conf, categories });
  }
  return out;
}

function matches(conf: Conference, rule: Record<string, unknown>): boolean {
  if (((rule.venues as string[] | null) ?? []).includes(conf.key)) return true;
  const subs = (rule.ccfddl_subs as string[] | null) ?? [];
  if (conf.upstream_sub && subs.includes(conf.upstream_sub)) return true;
  const sources = (rule.sources as string[] | null) ?? [];
  return sources.length > 0 && sources.some((s) => conf.sources.includes(s));
}

// --------------------------------------------------------------------------
// overrides
// --------------------------------------------------------------------------

export function applyOverrides(
  confs: Conference[],
  overrides: Record<string, unknown> | null | undefined,
): Conference[] {
  overrides = overrides ?? {};
  const dropped = new Set((overrides.drop as string[] | null) ?? []);
  const patches = (overrides.conferences as Record<string, unknown>) ?? {};
  const out: Conference[] = [];
  for (const conf of confs) {
    if (dropped.has(conf.key)) continue;
    const patch = patches[conf.key] as Record<string, unknown> | undefined;
    if (!patch) {
      out.push(conf);
      continue;
    }
    const next: Conference = { ...conf, editions: [...conf.editions] };
    const record = next as unknown as Record<string, unknown>;
    for (const field of ["title", "full_name", "link", "dblp", "upstream_sub"] as const) {
      if (field in patch) {
        const v = patch[field];
        record[field] = v === null ? null : String(v);
      }
    }
    if ("rank" in patch) {
      next.rank = {
        ...next.rank,
        ...Object.fromEntries(
          Object.entries((patch.rank as Record<string, unknown>) ?? {}).map(([k, v]) => [
            k,
            String(v),
          ]),
        ),
      };
    }
    for (const field of ["tags", "categories"] as const) {
      if (field in patch) {
        next[field] = ((patch[field] as unknown[] | null) ?? []).map((t) => String(t));
      }
    }
    const editionPatches = (patch.editions as Record<string, unknown>) ?? {};
    if (Object.keys(editionPatches).length > 0) {
      next.editions = patchEditions(next.editions, editionPatches);
    }
    out.push(next);
  }
  return out;
}

/** Drop paper/abstract deadlines that fall after the meeting ends (or starts, if event_end is null). */
export function sanitizeEditions(confs: Conference[]): Conference[] {
  return confs.map((conf) => ({
    ...conf,
    editions: conf.editions.map((edition) => {
      const meetingEnd = edition.event_end ?? edition.event_start;
      if (meetingEnd === null || edition.deadlines.length === 0) return edition;
      const kept = edition.deadlines.filter(
        (d) =>
          !(d.kind === "paper" || d.kind === "abstract") ||
          dateOnly(d.at_utc).getTime() <= dateOnly(meetingEnd).getTime(),
      );
      if (kept.length === edition.deadlines.length) return edition;
      return { ...edition, deadlines: kept };
    }),
  }));
}

function patchEditions(editions: Edition[], patches: Record<string, unknown>): Edition[] {
  const kept: Edition[] = [];
  const patchedYears = new Set<number>();
  for (const edition of editions) {
    const patch = patches[String(edition.year)] as Record<string, unknown> | undefined;
    if (patch === undefined) {
      kept.push(edition);
      continue;
    }
    patchedYears.add(edition.year);
    if (patch.drop) continue;
    const next: Edition = { ...edition, deadlines: [...edition.deadlines] };
    for (const field of ["link", "place", "date_text"] as const) {
      if (field in patch) next[field] = String(patch[field]);
    }
    for (const field of ["event_start", "event_end"] as const) {
      if (field in patch) next[field] = asDate(patch[field]);
    }
    if ("estimated" in patch) {
      // 推定版 (rollforward 生成) を実版へ昇格 / 降格させるための上書き。
      next.estimated = Boolean(patch.estimated);
    }
    if ("deadlines" in patch) {
      // 置換 (延長・訂正): 上流の古い締切を残さず差し替える (SPEC.md 3.5)。
      next.deadlines = deadlinesOf({ deadlines: patch.deadlines });
    }
    kept.push(next);
  }
  // 既存 edition に無い year の patch は新規 edition として追加する。
  for (const [yearKey, patch] of Object.entries(patches)) {
    if (!/^\d+$/.test(yearKey)) continue;
    const year = Number(yearKey);
    if (patchedYears.has(year)) continue;
    if (typeof patch !== "object" || patch === null) continue;
    const rec = patch as Record<string, unknown>;
    if (rec.drop) continue;
    const edition: Edition = {
      year,
      edition_id: `override-${year}`,
      link: "",
      place: "",
      date_text: "",
      event_start: null,
      event_end: null,
      deadlines: deadlinesOf({ deadlines: rec.deadlines ?? [] }),
      estimated: false,
      source: "override",
    };
    for (const field of ["link", "place", "date_text"] as const) {
      if (field in rec) edition[field] = String(rec[field]);
    }
    for (const field of ["event_start", "event_end"] as const) {
      if (field in rec) edition[field] = asDate(rec[field]);
    }
    kept.push(edition);
  }
  return kept;
}

// --------------------------------------------------------------------------
// roll-forward
// --------------------------------------------------------------------------

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n % 2 === 1) return sorted[(n - 1) / 2];
  return (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

/** Python's round(): halves go to the even neighbour. Values are non-negative here. */
function pyRound(x: number): number {
  const r = Math.round(x);
  if (Math.abs(x % 1) === 0.5) return r % 2 === 0 ? r : r - 1;
  return r;
}

export function rollforward(
  confs: Conference[],
  today: Date,
  config: Record<string, unknown>,
): Conference[] {
  const cfg = (config.rollforward as Record<string, unknown>) ?? {};
  const enabled = cfg.enabled === undefined ? true : Boolean(cfg.enabled);
  if (!enabled) return [...confs];
  const kinds = new Set((cfg.kinds as string[] | null) ?? ["abstract", "paper"]);
  const defaultInterval = Number(cfg.default_interval_days ?? 364);
  const lookback = Number(cfg.interval_lookback_editions ?? 3);
  const maxStale = Number(cfg.max_stale_days ?? 730);

  const out: Conference[] = [];
  for (const conf of confs) {
    const estimated = estimateEdition(conf, today, kinds, defaultInterval, lookback, maxStale);
    if (estimated !== null) {
      out.push({ ...conf, editions: [...conf.editions, estimated] });
    } else {
      out.push(conf);
    }
  }
  return out;
}

function estimateEdition(
  conf: Conference,
  today: Date,
  kinds: Set<string>,
  defaultInterval: number,
  lookback: number,
  maxStale: number,
): Edition | null {
  if (conf.editions.some((edition) => isFuture(edition, today))) return null;
  const dated: Array<{ edition: Edition; at: Date }> = [];
  for (const edition of [...conf.editions].sort((a, b) => a.year - b.year)) {
    if (edition.estimated) continue;
    const at = paperAt(edition);
    if (at !== null) dated.push({ edition, at });
  }
  if (dated.length === 0) return null;

  const last = dated[dated.length - 1];
  const stale = Math.floor((dateOnly(today).getTime() - dateOnly(last.at).getTime()) / DAY_MS);
  if (stale < 0 || stale > maxStale) return null;

  const interval = intervalDays(
    dated.slice(-lookback).map((d) => d.at),
    defaultInterval,
  );
  // Advance by whole intervals so the weekday is preserved.
  let steps = 1;
  while (
    steps < 3 &&
    dateOnly(addDays(last.at, interval * steps)).getTime() < dateOnly(today).getTime()
  ) {
    steps += 1;
  }
  const shift = interval * steps;
  if (dateOnly(addDays(last.at, shift)).getTime() < dateOnly(today).getTime()) {
    return null;
  }
  // Derive the year label from the shift actually applied.
  const year = last.edition.year + Math.max(1, Math.round(shift / 365.25));
  if (conf.editions.some((e) => e.year === year && !e.estimated)) {
    return null; // upstream already lists that edition, it just has no dates yet
  }

  const deadlines: Deadline[] = last.edition.deadlines
    .filter((d) => kinds.has(d.kind))
    .map((d) => ({
      ...d,
      at_utc: addDays(d.at_utc, shift),
      comment: `Estimated from the ${last.edition.year} edition`,
    }));
  if (deadlines.length === 0) return null;
  return {
    year,
    edition_id: `${conf.key}${String(year % 100).padStart(2, "0")}-est`,
    link: last.edition.link,
    place: "",
    date_text: "",
    event_start: null,
    event_end: null,
    deadlines,
    estimated: true,
    source: last.edition.source,
  };
}

function isFuture(edition: Edition, today: Date): boolean {
  if (
    edition.deadlines.some(
      (d) => d.kind === "paper" && dateOnly(d.at_utc).getTime() >= dateOnly(today).getTime(),
    )
  ) {
    return true;
  }
  return [edition.event_start, edition.event_end].some(
    (day) => day !== null && dateOnly(day).getTime() >= dateOnly(today).getTime(),
  );
}

function paperAt(edition: Edition): Date | null {
  const papers = edition.deadlines.filter((d) => d.kind === "paper").map((d) => d.at_utc);
  if (papers.length === 0) return null;
  return papers.reduce((a, b) => (a.getTime() < b.getTime() ? a : b));
}

function intervalDays(instants: Date[], defaultInterval: number): number {
  const gaps: number[] = [];
  for (let i = 0; i < instants.length - 1; i++) {
    gaps.push(Math.floor((instants[i + 1].getTime() - instants[i].getTime()) / DAY_MS));
  }
  if (gaps.length === 0) return defaultInterval;
  const estimate = pyRound(median(gaps) / 7) * 7; // multiples of 7 preserve the weekday
  return estimate >= 180 && estimate <= 900 ? estimate : defaultInterval;
}

// --------------------------------------------------------------------------
// select
// --------------------------------------------------------------------------

export function select(confs: Conference[], config: Record<string, unknown>): Conference[] {
  const enabled = new Set(Object.keys((config.categories as Record<string, unknown>) ?? {}));
  const excluded = new Set((config.exclude as string[] | null) ?? []);
  const rankFilter = (config.rank_filter as Record<string, unknown>) ?? {};
  const alwaysKeep = new Set((rankFilter.always_keep as string[] | null) ?? []);
  // Venues named under taxonomy are intentional inclusions.
  for (const rule of Object.values((config.taxonomy as Record<string, unknown>) ?? {})) {
    if (typeof rule === "object" && rule !== null) {
      for (const v of ((rule as Record<string, unknown>).venues as string[] | null) ?? []) {
        alwaysKeep.add(v);
      }
    }
  }
  const keepIfNoRank =
    rankFilter.keep_if_no_rank === undefined ? true : Boolean(rankFilter.keep_if_no_rank);
  const schemes: Record<string, unknown> = {};
  for (const [name, allowed] of Object.entries(rankFilter)) {
    // Python の `if ... and allowed` に相当: 空リスト (ccf: []) は falsy 扱い。
    if (
      name !== "keep_if_no_rank" &&
      name !== "always_keep" &&
      Array.isArray(allowed) &&
      allowed.length > 0
    ) {
      schemes[name] = allowed;
    }
  }

  const out: Conference[] = [];
  for (const conf of confs) {
    if (excluded.has(conf.key)) continue;
    const categories =
      enabled.size === 0 ? [...conf.categories] : conf.categories.filter((c) => enabled.has(c));
    if (categories.length === 0) continue;
    if (!alwaysKeep.has(conf.key) && !rankOk(conf, schemes, keepIfNoRank)) continue;
    // ジャーナル（tags: [journal]）は日付なしでも残す。venues 名指し（alwaysKeep）も同様 — 名指し＝収録意思。
    if (!alwaysKeep.has(conf.key) && !hasDates(conf) && !(conf.tags ?? []).includes("journal"))
      continue;
    out.push({ ...conf, categories });
  }
  return out;
}

function hasDates(conf: Conference): boolean {
  return conf.editions.some(
    (ed) => ed.deadlines.length > 0 || ed.event_start !== null || ed.event_end !== null,
  );
}

export function rankOk(
  conf: Conference,
  schemes: Record<string, unknown>,
  keepIfNoRank: boolean,
): boolean {
  const schemeEntries = Object.entries(schemes).map(
    ([name, allowed]) =>
      [
        name.toLowerCase().trim(),
        (Array.isArray(allowed) ? (allowed as string[]) : []).map((v) =>
          String(v).trim().toUpperCase(),
        ),
      ] as const,
  );
  if (schemeEntries.length === 0) return true;

  const confRank = new Map<string, string>();
  for (const [k, v] of Object.entries(conf.rank ?? {})) {
    if (v !== null && v !== undefined) {
      confRank.set(k.toLowerCase().trim(), String(v).trim());
    }
  }

  let hasRank = false;
  for (const [schemeName, allowedValues] of schemeEntries) {
    const rawValue = confRank.get(schemeName);
    if (!rawValue || ABSENT_RANKS.has(rawValue)) continue;
    hasRank = true;
    const normValue = rawValue.toUpperCase();
    if (allowedValues.includes(normValue) || allowedValues.includes(rawValue)) {
      return true;
    }
  }
  return keepIfNoRank && !hasRank;
}
