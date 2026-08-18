/**
 * Shared fixtures and helpers for the vitest suite.
 * Ported from tests/conftest.py (kamiyobi).
 */

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Conference, Deadline, DeadlineKind, Edition } from "../src/model.ts";

export const REPO_ROOT = join(import.meta.dirname, "..");
export const FIXTURES = join(import.meta.dirname, "fixtures");

// Deterministic "now" used by every build in the test suite.
export const NOW = new Date("2026-08-09T00:00:00Z");
export const NOW_ARG = "2026-08-09T00:00:00Z";

// public/ contents required by SPEC.md section 4. embeddings.json は golden テストが
// --no-embeddings で走るためここには含めない。
export const PUBLIC_FILES = [
  "index.html",
  "data.json",
  "catalog.json",
  "recommendation-index.json",
  "app.js",
  "data.csv",
  "upcoming.md",
  "llms.txt",
  ".nojekyll",
];

/** 'YYYY-MM-DDTHH:MM:SSZ' の UTC 時刻を作る。 */
export function utc(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): Date {
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s));
}

// --- factories ----------------------------------------------------------------

export function makeDeadline(
  kind: DeadlineKind,
  label: string,
  atUtc: Date,
  tzRaw = "AoE",
  round = 1,
  comment: string | null = null,
): Deadline {
  return { kind, label, at_utc: atUtc, tz_raw: tzRaw, round, comment };
}

export function makeEdition(overrides: Partial<Edition> & { year: number }): Edition {
  return {
    edition_id: "",
    link: "https://example.org/",
    place: "Somewhere",
    date_text: "",
    event_start: null,
    event_end: null,
    deadlines: [],
    estimated: false,
    source: "ccfddl",
    ...overrides,
  };
}

export function makeConference(
  overrides: Partial<Conference> & { key: string; title: string },
): Conference {
  return {
    full_name: overrides.title,
    link: "https://example.org/",
    rank: {},
    dblp: null,
    upstream_sub: null,
    tags: [],
    categories: [],
    editions: [],
    sources: ["ccfddl"],
    ...overrides,
  };
}

// --- offline fixture cache -----------------------------------------------------

const REPOS: Array<[string, string, string, string]> = [
  ["ccfddl/ccf-deadlines", "ccf-deadlines-main", "ccfddl", "conference"],
  ["huggingface/ai-deadlines", "ai-deadlines-main", "aideadlines", "src"],
];

/** An offline cache directory whose only data source is tests/fixtures/. */
export function makeFixtureCache(dir: string): string {
  mkdirSync(dir, { recursive: true });
  for (const [repo, top, fixtureDir, payload] of REPOS) {
    const slot = join(dir, `${repo.replace("/", "__")}__main`);
    mkdirSync(join(slot, top), { recursive: true });
    cpSync(join(FIXTURES, fixtureDir, payload), join(slot, top, payload), {
      recursive: true,
    });
  }
  return dir;
}

export function tempCache(): string {
  return makeFixtureCache(mkdtempSync(join(tmpdir(), "cfp-cache-")));
}

// --- run the CLI ---------------------------------------------------------------

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Run `node src/cli.ts build` offline against the fixture cache. */
export function runCli(
  outdir: string,
  options: { now?: string; cache?: string; extra?: string[] } = {},
): RunResult {
  const cache = options.cache ?? tempCache();
  const cmd = [
    "node",
    join(REPO_ROOT, "src", "cli.ts"),
    "build",
    "--out",
    outdir,
    "--offline",
    "--cache",
    cache,
    "--now",
    options.now ?? NOW_ARG,
    ...(options.extra ?? []),
  ];
  const proc = spawnSync(cmd[0], cmd.slice(1), {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 300_000,
  });
  return { status: proc.status, stdout: proc.stdout, stderr: proc.stderr };
}
