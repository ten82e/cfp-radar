import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { REPO_ROOT } from "./helpers.ts";

const report = {
  schema_version: 1,
  generated_at: "2026-08-09T00:00:00Z",
  profile_hash: "profile-a",
  source_failures: [],
  snapshot_fallback: false,
  confirmed_future_deadlines: 10,
  confirmed_deadlines: 10,
  required_venues: { rtss: "present" },
  parse_warning_count: 1,
  parse_warnings: { one: 1 },
  category_counts: { systems: 1 },
  category_distribution: { systems: 1 },
};

it("health-gate reads last-known-good and writes the next explicit artifact", () => {
  const dir = mkdtempSync(join(tmpdir(), "kamiyobi-health-gate-"));
  const current = join(dir, "health.json");
  const previous = join(dir, "last-known-good.json");
  const next = join(dir, "next-last-known-good.json");
  writeFileSync(current, `${JSON.stringify(report)}\n`);
  writeFileSync(previous, `${JSON.stringify(report)}\n`);

  const passed = spawnSync(process.execPath, ["scripts/health-gate.ts", current, previous, next], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  expect(passed.status, passed.stderr).toBe(0);
  expect(JSON.parse(readFileSync(next, "utf8"))).toEqual(report);

  const blocked = join(dir, "blocked.json");
  const blockedNext = join(dir, "blocked-next.json");
  writeFileSync(blocked, `${JSON.stringify({ ...report, source_failures: ["ccfddl"] })}\n`);
  const failed = spawnSync(
    process.execPath,
    ["scripts/health-gate.ts", blocked, previous, blockedNext],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  expect(failed.status).toBe(1);
  expect(existsSync(blockedNext)).toBe(false);
});
