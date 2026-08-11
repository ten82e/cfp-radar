/**
 * Source protocol and tarball fetching (Node built-ins only, no HTTP dep).
 * Ported from scripts/sources/base.py.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { warn } from "../model.ts";

export const USER_AGENT = "conf-deadlines/1.0 (+https://github.com/ccfddl; node)";
export const CODELOAD = "https://codeload.github.com/{repo}/tar.gz/refs/heads/{ref}";

export interface Source {
  name: string;
  load(cacheDir: string, options?: { offline?: boolean }): Promise<unknown[]>;
}

function cacheSlot(cacheDir: string, repo: string, ref: string): string {
  return join(cacheDir, `${repo.replace("/", "__")}__${ref}`);
}

/** The single top-level directory inside an extracted tarball, or null. */
export function extractedRoot(slot: string): string | null {
  if (!existsSync(slot)) return null;
  const children = readdirSync(slot).filter((p) => statSync(join(slot, p)).isDirectory());
  return children.length === 1 ? join(slot, children[0]) : null;
}

async function download(url: string, dest: string): Promise<void> {
  const response = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(dest, buffer);
}

/**
 * Download and extract `repo` at `ref`; return the extracted root.
 * `offline` uses the cache only and throws when it is missing.  A network
 * failure falls back to an existing cache with a warning.
 */
export async function fetchTarball(
  repo: string,
  ref: string,
  cacheDir: string,
  options: { offline?: boolean } = {},
): Promise<string> {
  const offline = Boolean(options.offline);
  const slot = cacheSlot(cacheDir, repo, ref);
  const cached = extractedRoot(slot);

  if (offline) {
    if (cached === null) {
      throw new Error(`no cached copy of ${repo}@${ref} under ${cacheDir}`);
    }
    return cached;
  }

  mkdirSync(cacheDir, { recursive: true });
  const url = CODELOAD.replace("{repo}", repo).replace("{ref}", ref);
  const tmp = mkdtempSync(join(cacheDir, ".fetch-"));
  try {
    const archive = join(tmp, "archive.tar.gz");
    await download(url, archive);
    const staging = join(tmp, "x");
    mkdirSync(staging);
    // system tar is guaranteed on ubuntu-latest and macOS runners.
    execFileSync("tar", ["-xzf", archive, "-C", staging]);
    if (extractedRoot(staging) === null) {
      throw new Error(`unexpected tarball layout for ${repo}@${ref}`);
    }
    if (existsSync(slot)) rmSync(slot, { recursive: true });
    renameSync(staging, slot);
  } catch (exc) {
    if (cached !== null) {
      warn(`fetch of ${repo}@${ref} failed (${String(exc)}); using cached copy`);
      return cached;
    }
    throw exc;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  const root = extractedRoot(slot);
  if (root === null) {
    throw new Error(`unexpected tarball layout for ${repo}@${ref}`);
  }
  return root;
}

export { tmpdir };
