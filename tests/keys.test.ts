/**
 * Conference keys: SPEC.md section 3.1.
 * Ported from tests/test_keys.py.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";
import { applyAliases, mergeSources } from "../src/merge.ts";
import type { Conference } from "../src/model.ts";
import { makeConference, makeDeadline, makeEdition, REPO_ROOT, runCli } from "./helpers.ts";

function at(month: number, day: number): Date {
  return new Date(Date.UTC(2026, month - 1, day, 11, 59, 59));
}

function twoSources(): [Conference, Conference] {
  const hf = makeConference({
    key: "kdd",
    title: "KDD",
    sources: ["aideadlines"],
    editions: [
      makeEdition({
        year: 2026,
        edition_id: "kdd26",
        source: "aideadlines",
        deadlines: [makeDeadline("abstract", "abs", at(2, 2), "AoE")],
      }),
    ],
  });
  const ccf = makeConference({
    key: "sigkdd",
    title: "SIGKDD",
    upstream_sub: "DB",
    rank: { ccf: "A" },
    sources: ["ccfddl"],
    editions: [
      makeEdition({
        year: 2026,
        edition_id: "kdd26",
        source: "ccfddl",
        deadlines: [makeDeadline("paper", "paper", at(2, 9), "AoE")],
      }),
    ],
  });
  return [hf, ccf];
}

describe("aliases", () => {
  it("without aliases the two spellings stay apart", () => {
    const [hf, ccf] = twoSources();
    const merged = mergeSources([[hf], [ccf]], {});
    expect(new Set(merged.map((c) => c.key))).toEqual(new Set(["kdd", "sigkdd"]));
  });

  it("aliases merge across sources", () => {
    const [hf, ccf] = twoSources();
    const groups = applyAliases([[hf], [ccf]], { kdd: "sigkdd" });
    const merged = mergeSources(groups, { source_priority: ["aideadlines", "ccfddl"] });
    expect(merged.map((c) => c.key)).toEqual(["sigkdd"]);
    const conf = merged[0];
    expect(new Set(conf.sources)).toEqual(new Set(["aideadlines", "ccfddl"]));
    expect(conf.rank.ccf).toBe("A");
    expect(conf.editions.length).toBe(1);
    const kinds = new Set(conf.editions[0].deadlines.map((d) => d.kind));
    expect(kinds).toEqual(new Set(["abstract", "paper"]));
  });

  it("alias table does not touch unrelated keys", () => {
    const [hf, ccf] = twoSources();
    const groups = applyAliases([[hf], [ccf]], { siggraph: "acm-siggraph" });
    expect(groups.flat().map((c) => c.key)).toEqual(["kdd", "sigkdd"]);
  });

  it("repository alias table is the one spec records", () => {
    const overrides =
      (loadYaml(readFileSync(join(REPO_ROOT, "data", "overrides.yaml"), "utf8")) as Record<
        string,
        unknown
      >) ?? {};
    const aliases = (overrides.aliases as Record<string, unknown>) ?? {};
    expect(aliases.kdd).toBe("sigkdd");
    expect(aliases.siggraph).toBe("acm-siggraph");
    expect(aliases.cec).toBe("ieee-cec");
  });
});

describe("collisions", () => {
  it("same slug from different subfields stays two conferences", () => {
    const fse = (sub: string, fullName: string): Conference =>
      makeConference({
        key: "fse",
        title: "FSE",
        full_name: fullName,
        upstream_sub: sub,
        sources: ["ccfddl"],
        editions: [
          makeEdition({
            year: 2026,
            edition_id: "fse26",
            deadlines: [makeDeadline("paper", "p", at(3, 1), "AoE")],
          }),
        ],
      });
    const merged = mergeSources(
      [[fse("SC", "Fast Software Encryption"), fse("SE", "Foundations of SE")]],
      {},
    );
    expect(merged.length).toBe(2);
    expect(new Set(merged.map((c) => c.key)).size).toBe(2);
  });

  it("built keys are unique", () => {
    const outdir = join(mkdtempSync(join(tmpdir(), "cfp-keys-")), "site");
    // 埋め込み生成は 2 モデル（英語+多言語）で数秒かかるためキー検証ではスキップ
    const result = runCli(outdir, { extra: ["--no-embeddings"] });
    expect(result.status).toBe(0);
    const data = JSON.parse(readFileSync(join(outdir, "data.json"), "utf8")) as {
      conferences: Array<{ key: string }>;
    };
    const keys = data.conferences.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
