/**
 * merge / classify / overrides / rollforward / select: SPEC.md sections 3 and 5.
 * Ported from tests/test_merge.py.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import { beforeAll, describe, expect, it } from "vitest";
import {
  applyAliases,
  applyOverrides,
  classify,
  dedupDeadlinesAfterRollforward,
  mergeSources,
  rankOk,
  rollforward,
  sanitizeEditions,
  select,
} from "../src/merge.ts";
import { type Conference, conferencesFromJson, type Deadline, type Edition } from "../src/model.ts";
import { DEFAULT_PATH, parseFile } from "../src/sources/local.ts";
import { makeConference, makeDeadline, makeEdition, REPO_ROOT } from "./helpers.ts";

const TODAY = new Date(Date.UTC(2026, 7, 9));
let CONFIG: Record<string, unknown> = {};

beforeAll(() => {
  CONFIG =
    (loadYaml(readFileSync(join(REPO_ROOT, "config.yaml"), "utf8")) as Record<string, unknown>) ??
    {};
});

/** このファイルの utc は h=23, mi=59, s=59 が既定。 */
function utc(y: number, mo: number, d: number, h = 23, mi = 59, s = 59): Date {
  return new Date(Date.UTC(y, mo - 1, d, h, mi, s));
}

function deadlinesOf(conf: Conference): Deadline[] {
  return conf.editions.flatMap((ed) => ed.deadlines);
}

function editionByYear(conf: Conference, year: number): Edition {
  const matches = conf.editions.filter((ed) => ed.year === year);
  expect(matches.length).toBeGreaterThan(0);
  return matches[0];
}

function byKey(confs: Conference[]): Record<string, Conference> {
  return Object.fromEntries(confs.map((c) => [c.key, c]));
}

const PRIORITY: Record<string, unknown> = {
  source_priority: ["local", "aideadlines", "ccfddl"],
};

describe("merge_sources", () => {
  it("two sources for the same conference are merged", () => {
    const ccf = makeConference({
      key: "acl",
      title: "ACL",
      upstream_sub: "AI",
      sources: ["ccfddl"],
      rank: { ccf: "A", core: "A*" },
      editions: [
        makeEdition({
          year: 2026,
          edition_id: "acl26",
          date_text: "July 2 - 7, 2026",
          source: "ccfddl",
          deadlines: [makeDeadline("paper", "Paper", utc(2026, 1, 5), "AoE")],
        }),
      ],
    });
    const hf = makeConference({
      key: "acl",
      title: "ACL",
      sources: ["aideadlines"],
      editions: [
        makeEdition({
          year: 2026,
          edition_id: "acl26",
          event_start: new Date(Date.UTC(2026, 6, 2)),
          event_end: new Date(Date.UTC(2026, 6, 7)),
          source: "aideadlines",
          deadlines: [makeDeadline("notification", "Notification", utc(2026, 3, 26), "AoE")],
        }),
      ],
    });

    const merged = mergeSources([[ccf], [hf]], {});
    expect(merged.length).toBe(1);
    const conf = merged[0];
    expect(conf.key).toBe("acl");
    expect(new Set(conf.sources)).toEqual(new Set(["ccfddl", "aideadlines"]));
    expect(conf.editions.length).toBe(1);
    expect(new Set(deadlinesOf(conf).map((d) => d.kind))).toEqual(
      new Set(["paper", "notification"]),
    );
  });

  it("real edition replaces estimated one", () => {
    const ccf = makeConference({
      key: "dasfaa",
      title: "DASFAA",
      sources: ["ccfddl"],
      editions: [
        makeEdition({
          year: 2026,
          edition_id: "dasfaa26",
          source: "ccfddl",
          deadlines: [makeDeadline("paper", "Paper", utc(2025, 10, 28), "AoE")],
        }),
        makeEdition({
          year: 2027,
          edition_id: "dasfaa27-est",
          estimated: true,
          source: "ccfddl",
          deadlines: [
            makeDeadline("abstract", "Abstract", utc(2026, 9, 22), "AoE"),
            makeDeadline("paper", "Paper", utc(2026, 9, 29), "AoE"),
          ],
        }),
      ],
    });
    const local = makeConference({
      key: "dasfaa",
      title: "DASFAA",
      sources: ["local"],
      editions: [
        makeEdition({
          year: 2027,
          edition_id: "dasfaa27",
          source: "local",
          deadlines: [makeDeadline("paper", "Full Paper", utc(2027, 6, 7), "AoE")],
        }),
      ],
    });

    for (const groups of [
      [[local], [ccf]],
      [[ccf], [local]],
    ]) {
      const merged = mergeSources(groups, { source_priority: ["local", "ccfddl"] });
      expect(merged.length).toBe(1);
      const ed27 = editionByYear(merged[0], 2027);
      expect(ed27.estimated).toBe(false);
      expect(ed27.deadlines.map((d) => [d.kind, d.at_utc.getTime()])).toEqual([
        ["paper", utc(2027, 6, 7).getTime()],
      ]);
    }
  });

  it("distinct conferences are kept apart", () => {
    const a = makeConference({ key: "sigcomm", title: "SIGCOMM" });
    const b = makeConference({ key: "nsdi", title: "NSDI" });
    const merged = mergeSources([[a], [b]], {});
    expect(new Set(merged.map((c) => c.key))).toEqual(new Set(["sigcomm", "nsdi"]));
  });

  it("rounds are preserved", () => {
    const conf = makeConference({
      key: "nsdi",
      title: "NSDI",
      upstream_sub: "NW",
      editions: [
        makeEdition({
          year: 2027,
          edition_id: "nsdi27",
          deadlines: [
            makeDeadline("abstract", "Abstract r1", utc(2026, 4, 16), "UTC-4", 1),
            makeDeadline("paper", "Paper r1", utc(2026, 4, 23), "UTC-4", 1),
            makeDeadline("abstract", "Abstract r2", utc(2026, 9, 10), "UTC-4", 2),
            makeDeadline("paper", "Paper r2", utc(2026, 9, 17), "UTC-4", 2),
          ],
        }),
      ],
    });
    const merged = mergeSources([[conf]], {});
    const dls = deadlinesOf(merged[0]);
    expect(dls.length).toBe(4);
    expect(new Set(dls.map((d) => `${d.kind}:${d.round}`))).toEqual(
      new Set(["abstract:1", "paper:1", "abstract:2", "paper:2"]),
    );
  });

  it("conflicting deadlines resolved by source priority", () => {
    const low = makeConference({
      key: "sigcomm",
      title: "SIGCOMM",
      sources: ["ccfddl"],
      editions: [
        makeEdition({
          year: 2026,
          edition_id: "sigcomm26",
          source: "ccfddl",
          deadlines: [makeDeadline("paper", "ccf", utc(2026, 2, 6), "AoE", 1)],
        }),
      ],
    });
    const high = makeConference({
      key: "sigcomm",
      title: "SIGCOMM",
      sources: ["aideadlines"],
      editions: [
        makeEdition({
          year: 2026,
          edition_id: "sigcomm26",
          source: "aideadlines",
          deadlines: [makeDeadline("paper", "hf", utc(2026, 2, 20), "AoE", 1)],
        }),
      ],
    });

    const config = { source_priority: ["local", "aideadlines", "ccfddl"] };
    const merged = mergeSources([[low], [high]], config);
    const dls = deadlinesOf(merged[0]).filter((d) => d.kind === "paper" && d.round === 1);
    expect(new Set(dls.map((d) => d.at_utc.getTime()))).toEqual(
      new Set([utc(2026, 2, 6).getTime(), utc(2026, 2, 20).getTime()]),
    );

    const flipped = mergeSources([[low], [high]], {
      source_priority: ["ccfddl", "aideadlines", "local"],
    });
    const dls2 = deadlinesOf(flipped[0]).filter((d) => d.kind === "paper" && d.round === 1);
    expect(new Set(dls2.map((d) => d.at_utc.getTime()))).toEqual(
      new Set([utc(2026, 2, 6).getTime(), utc(2026, 2, 20).getTime()]),
    );
  });

  it("identical deadlines from two sources are not duplicated", () => {
    const one = (source: string, label: string): Conference =>
      makeConference({
        key: "sigcomm",
        title: "SIGCOMM",
        sources: [source],
        editions: [
          makeEdition({
            year: 2026,
            edition_id: "sigcomm26",
            source,
            deadlines: [makeDeadline("paper", label, utc(2026, 2, 6), "AoE", 1)],
          }),
        ],
      });
    const merged = mergeSources([[one("ccfddl", "ccf")], [one("aideadlines", "hf")]], PRIORITY);
    const dls = deadlinesOf(merged[0]);
    expect(dls.length).toBe(1);
    expect(dls[0].label).toBe("hf");
  });

  it("three notifications in one edition survive a merge", () => {
    const days = [5, 20, 25];
    const hf = makeConference({
      key: "sigcomm",
      title: "SIGCOMM",
      sources: ["aideadlines"],
      editions: [
        makeEdition({
          year: 2026,
          edition_id: "sigcomm26",
          source: "aideadlines",
          deadlines: days.map((d) =>
            makeDeadline("notification", `n${d}`, utc(2026, 3, d), "AoE", 1),
          ),
        }),
      ],
    });
    const ccf = makeConference({
      key: "sigcomm",
      title: "SIGCOMM",
      sources: ["ccfddl"],
      editions: [
        makeEdition({
          year: 2026,
          edition_id: "sigcomm26",
          source: "ccfddl",
          deadlines: [makeDeadline("notification", "ccf", utc(2026, 3, 5), "AoE", 1)],
        }),
      ],
    });
    for (const groups of [
      [[hf], [ccf]],
      [[ccf], [hf]],
    ]) {
      const merged = mergeSources(groups, PRIORITY);
      const kept = new Set(deadlinesOf(merged[0]).map((d) => d.at_utc.getTime()));
      expect(kept).toEqual(new Set(days.map((d) => utc(2026, 3, d).getTime())));
    }
  });

  // --- deadline de-duplication (SPEC.md 3.6 tolerance window) ---

  function sigcomm(source: string, deadlines: Deadline[], year = 2026): Conference {
    return makeConference({
      key: "sigcomm",
      title: "SIGCOMM",
      sources: [source],
      editions: [
        makeEdition({
          year,
          edition_id: `sigcomm${year % 100}`,
          source,
          deadlines,
        }),
      ],
    });
  }

  it("near duplicate from two sources is one deadline", () => {
    const ccf = sigcomm("ccfddl", [
      makeDeadline("paper", "Paper submission", utc(2026, 2, 6, 11, 59, 0)),
    ]);
    const hf = sigcomm("aideadlines", [
      makeDeadline("paper", "Paper submission deadline", utc(2026, 2, 6, 11, 59, 59)),
    ]);
    const merged = mergeSources([[ccf], [hf]], PRIORITY);
    const dls = deadlinesOf(merged[0]);
    expect(dls.length).toBe(1);
    expect(dls[0].at_utc.getTime()).toBe(utc(2026, 2, 6, 11, 59, 59).getTime());
    expect(dls[0].label).toBe("Paper submission deadline");
    expect(dls[0].comment ?? "").toContain("Paper submission");
  });

  it("same instant in two rounds of one source is one deadline", () => {
    const conf = sigcomm("ccfddl", [
      makeDeadline("paper", "Paper submission", utc(2026, 1, 27), "AoE", 1),
      makeDeadline("paper", "Paper submission", utc(2026, 1, 27), "AoE", 2),
    ]);
    const dls = deadlinesOf(mergeSources([[conf]], PRIORITY)[0]);
    expect(dls.length).toBe(1);
    expect(dls[0].round).toBe(1);
  });

  it("round disagreement between sources is one deadline", () => {
    const ccf = sigcomm("ccfddl", [
      makeDeadline("paper", "Paper submission", utc(2026, 8, 29), "AoE", 2),
    ]);
    const hf = sigcomm("aideadlines", [
      makeDeadline("paper", "Round 2 Paper Submissions", utc(2026, 8, 29), "AoE", 1),
    ]);
    const dls = deadlinesOf(mergeSources([[ccf], [hf]], PRIORITY)[0]);
    expect(dls.length).toBe(1);
    expect(dls[0].label).toBe("Round 2 Paper Submissions");
    expect(dls[0].round).toBe(2);
  });

  it("genuine rounds months apart are not merged", () => {
    const conf = sigcomm("ccfddl", [
      makeDeadline("paper", "Paper submission", utc(2026, 4, 24), "AoE", 1),
      makeDeadline("paper", "Paper submission", utc(2026, 9, 18), "AoE", 2),
    ]);
    const dls = deadlinesOf(mergeSources([[conf]], PRIORITY)[0]);
    expect(new Set(dls.map((d) => `${d.round}:${d.at_utc.getTime()}`))).toEqual(
      new Set([`1:${utc(2026, 4, 24).getTime()}`, `2:${utc(2026, 9, 18).getTime()}`]),
    );
  });

  it("deadlines just outside the window are not merged", () => {
    const conf = sigcomm("ccfddl", [
      makeDeadline("paper", "a", utc(2026, 2, 6, 0, 0, 0)),
      makeDeadline("paper", "b", utc(2026, 2, 6, 1, 0, 1)),
    ]);
    expect(deadlinesOf(mergeSources([[conf]], PRIORITY)[0]).length).toBe(2);
  });

  it("different kinds at the same instant are not merged", () => {
    const conf = sigcomm("ccfddl", [
      makeDeadline("paper", "Paper", utc(2026, 5, 7)),
      makeDeadline("supplementary", "Supplementary", utc(2026, 5, 7)),
    ]);
    const dls = deadlinesOf(mergeSources([[conf]], PRIORITY)[0]);
    expect(new Set(dls.map((d) => d.kind))).toEqual(new Set(["paper", "supplementary"]));
  });

  it("merge count is reported in the stats", () => {
    const conf = sigcomm("ccfddl", [
      makeDeadline("paper", "Paper submission", utc(2026, 1, 27), "AoE", 1),
      makeDeadline("paper", "Paper submission", utc(2026, 1, 27), "AoE", 2),
      makeDeadline("paper", "Paper submission", utc(2026, 1, 27), "AoE", 3),
    ]);
    const stats = { merged_deadlines: 0, merged_by_key: {} as Record<string, number> };
    mergeSources([[conf]], PRIORITY, stats);
    expect(stats.merged_deadlines).toBe(2);
    expect(stats.merged_by_key.sigcomm).toBe(2);
  });

  it("cross source tolerance is configurable", () => {
    const ccf = sigcomm("ccfddl", [
      makeDeadline("paper", "Paper submission", utc(2026, 2, 6, 0, 0, 0)),
      makeDeadline("paper", "Other track", utc(2026, 3, 1, 0, 0, 0)),
    ]);
    const hf = sigcomm("aideadlines", [
      makeDeadline("paper", "Paper deadline", utc(2026, 2, 6, 8, 0, 0)),
      makeDeadline("paper", "Other track", utc(2026, 3, 1, 0, 0, 0)),
    ]);
    const tight = {
      ...PRIORITY,
      deadline_merge_cross_source_seconds: 0,
      deadline_merge_one_to_one_max_seconds: 0,
    };
    expect(deadlinesOf(mergeSources([[ccf], [hf]], tight)[0]).length).toBe(3);
    expect(deadlinesOf(mergeSources([[ccf], [hf]], PRIORITY)[0]).length).toBe(2);
  });

  it.each([
    [1, "an hour of timezone plus a second of rounding"],
    [4, "the sources read the same wall clock in different zones"],
    [12, "half a day apart"],
    [24, "the sources disagree about the calendar day"],
  ] as Array<[number, string]>)(
    "sources disagreeing by %i hours still make one deadline",
    (hours) => {
      const base = utc(2026, 2, 2, 11, 59, 59);
      const ccf = sigcomm("ccfddl", [makeDeadline("paper", "Paper submission", base)]);
      const hf = sigcomm("aideadlines", [
        makeDeadline("paper", "Paper Submission", new Date(base.getTime() + hours * 3_600_000)),
      ]);
      const dls = deadlinesOf(mergeSources([[ccf], [hf]], PRIORITY)[0]);
      expect(dls.length).toBe(1);
    },
  );

  it("one source filing several tracks at one instant keeps them all", () => {
    const at = utc(2026, 4, 21, 22, 0, 0);
    const conf = sigcomm("aideadlines", [
      makeDeadline("paper", "Appy Hour deadline", at),
      makeDeadline("paper", "Posters deadline", at),
      makeDeadline("paper", "Student Research Competition deadline", at),
    ]);
    const dls = deadlinesOf(mergeSources([[conf]], PRIORITY)[0]);
    expect(new Set(dls.map((d) => d.label))).toEqual(
      new Set(["Appy Hour deadline", "Posters deadline", "Student Research Competition deadline"]),
    );
  });

  it("one source repeating a label at one instant is one deadline", () => {
    const at = utc(2026, 1, 26, 23, 59, 0);
    const conf = sigcomm("ccfddl", [
      makeDeadline("paper", "Paper submission", at, "AoE", 1, "Full papers"),
      makeDeadline("paper", " paper  SUBMISSION ", at, "AoE", 2, "Poster-only papers"),
    ]);
    const dls = deadlinesOf(mergeSources([[conf]], PRIORITY)[0]);
    expect(dls.length).toBe(1);
    expect(dls[0].round).toBe(1);
    expect(dls[0].comment ?? "").toContain("Poster-only papers");
  });

  it("a cross source match goes to the nearest candidate", () => {
    const at = utc(2026, 1, 22, 22, 0, 0);
    const hf = sigcomm("aideadlines", [
      makeDeadline(
        "paper",
        "Upload and conflicts deadline",
        new Date(at.getTime() + 24 * 3_600_000),
      ),
      makeDeadline("paper", "Technical Papers deadline", at),
    ]);
    const ccf = sigcomm("ccfddl", [makeDeadline("paper", "Paper submission", at)]);
    const dls = deadlinesOf(mergeSources([[ccf], [hf]], PRIORITY)[0]);
    expect(dls.length).toBe(2);
    const absorbed = dls.filter((d) => (d.comment ?? "").includes("Paper submission"));
    expect(absorbed.map((d) => d.label)).toEqual(["Technical Papers deadline"]);
  });

  it("dedup runs again behind rollforward", () => {
    const at = utc(2027, 2, 1, 23, 59, 0);
    const conf = makeConference({
      key: "sgp",
      title: "SGP",
      sources: ["ccfddl"],
      editions: [
        makeEdition({
          year: 2027,
          edition_id: "sgp27-est",
          estimated: true,
          source: "ccfddl",
          deadlines: [
            makeDeadline("paper", "Paper submission", at),
            makeDeadline("paper", "Paper submission", at),
          ],
        }),
      ],
    });
    const stats = { merged_deadlines: 0, merged_by_key: {} as Record<string, number> };
    const out = dedupDeadlinesAfterRollforward([conf], PRIORITY, stats);
    expect(deadlinesOf(out[0]).length).toBe(1);
    expect(stats.merged_deadlines).toBe(1);
  });
});

describe("classify", () => {
  it("assigns categories from upstream_sub", () => {
    const nw = makeConference({ key: "sigcomm", title: "SIGCOMM", upstream_sub: "NW" });
    const out = byKey(classify([nw], CONFIG));
    expect(out.sigcomm.categories).toContain("networking");
  });

  it("places sc in hpc", () => {
    const sc = makeConference({ key: "sc", title: "SC", upstream_sub: "DS" });
    const out = byKey(classify([sc], CONFIG));
    expect(out.sc.categories).toContain("hpc");
  });

  it("only uses declared categories", () => {
    const allowed = new Set(["hpc", "networking", "systems", "ai", "security"]);
    const confs = [
      makeConference({ key: "sigcomm", title: "SIGCOMM", upstream_sub: "NW" }),
      makeConference({ key: "sc", title: "SC", upstream_sub: "DS" }),
      makeConference({ key: "neurips", title: "NeurIPS", upstream_sub: "AI" }),
    ];
    for (const conf of classify(confs, CONFIG)) {
      expect(conf.categories.every((c) => allowed.has(c))).toBe(true);
    }
  });
});

describe("apply_overrides", () => {
  it("empty overrides is a no-op", () => {
    const confs = [
      makeConference({
        key: "sigcomm",
        title: "SIGCOMM",
        editions: [
          makeEdition({
            year: 2026,
            edition_id: "sigcomm26",
            deadlines: [makeDeadline("paper", "Paper", utc(2026, 2, 6), "AoE")],
          }),
        ],
      }),
    ];
    const out = applyOverrides(confs, {});
    expect(out.map((c) => c.key)).toEqual(confs.map((c) => c.key));
    expect(deadlinesOf(out[0]).map((d) => d.at_utc.getTime())).toEqual(
      deadlinesOf(confs[0]).map((d) => d.at_utc.getTime()),
    );
  });

  it("repo overrides file applies without error", () => {
    const path = join(REPO_ROOT, "data", "overrides.yaml");
    let overrides: Record<string, unknown> = {};
    try {
      overrides = (loadYaml(readFileSync(path, "utf8")) as Record<string, unknown>) ?? {};
    } catch {
      return; // ファイルが無い環境ではスキップ
    }
    const confs = [makeConference({ key: "sigcomm", title: "SIGCOMM" })];
    const out = applyOverrides(confs, overrides);
    expect(Array.isArray(out)).toBe(true);
  });

  it("override replaces deadlines", () => {
    const confs = [
      makeConference({
        key: "mmm",
        title: "MMM",
        editions: [
          makeEdition({
            year: 2027,
            edition_id: "mmm27",
            deadlines: [makeDeadline("paper", "Paper", utc(2026, 8, 17), "AoE")],
          }),
        ],
      }),
    ];
    const overrides = {
      conferences: {
        mmm: {
          editions: {
            2027: {
              deadlines: [
                {
                  kind: "paper",
                  label: "Regular paper submission (extended)",
                  date: "2026-08-30 23:59:00",
                  tz: "AoE",
                },
              ],
            },
          },
        },
      },
    };
    const out = applyOverrides(confs, overrides);
    const edition = out[0].editions[0];
    expect(edition.deadlines.length).toBe(1);
    expect(edition.deadlines[0].at_utc.getTime()).toBe(utc(2026, 8, 31, 11, 59, 0).getTime());
    expect(edition.deadlines[0].label).toBe("Regular paper submission (extended)");
  });

  it("override promotes an estimated edition to real and replaces deadlines", () => {
    // acisp27-est: rollforward 由来の推定版 (12/11・3/12) を公式 CFP (11/30・3/1 AoE) に訂正。
    const confs = [
      makeConference({
        key: "acisp",
        title: "ACISP",
        editions: [
          makeEdition({
            year: 2027,
            edition_id: "acisp27-est",
            estimated: true,
            deadlines: [
              makeDeadline("paper", "Paper submission", utc(2026, 12, 11, 11, 59, 59), "AoE", 1),
              makeDeadline("paper", "Paper submission", utc(2027, 3, 12, 11, 59, 59), "AoE", 2),
            ],
          }),
        ],
      }),
    ];
    const overrides = {
      conferences: {
        acisp: {
          editions: {
            2027: {
              estimated: false,
              link: "https://acisp.org/",
              place: "Melbourne, Australia",
              deadlines: [
                {
                  kind: "paper",
                  label: "Paper submission (Round 1)",
                  date: "2026-11-30 23:59:59",
                  tz: "AoE",
                },
                {
                  kind: "paper",
                  label: "Paper submission (Round 2)",
                  date: "2027-03-01 23:59:59",
                  tz: "AoE",
                },
              ],
            },
          },
        },
      },
    };
    const out = applyOverrides(confs, overrides);
    const edition = out[0].editions[0];
    expect(edition.estimated).toBe(false);
    expect(edition.link).toBe("https://acisp.org/");
    expect(edition.place).toBe("Melbourne, Australia");
    expect(edition.deadlines.length).toBe(2);
    // AoE = UTC-12: 11/30 23:59:59 AoE → 12/01 11:59:59Z、3/1 23:59:59 AoE → 3/2 11:59:59Z。
    expect(edition.deadlines[0].at_utc.getTime()).toBe(utc(2026, 12, 1, 11, 59, 59).getTime());
    expect(edition.deadlines[1].at_utc.getTime()).toBe(utc(2027, 3, 2, 11, 59, 59).getTime());
    expect(edition.deadlines[0].label).toBe("Paper submission (Round 1)");
    expect(edition.deadlines[1].label).toBe("Paper submission (Round 2)");
    expect(edition.deadlines[0].round).toBe(1);
    expect(edition.deadlines[1].round).toBe(2);
  });

  it("override adds missing edition", () => {
    const confs = [
      makeConference({
        key: "setta",
        title: "SETTA",
        editions: [
          makeEdition({
            year: 2025,
            edition_id: "setta25",
            deadlines: [makeDeadline("paper", "Paper", utc(2025, 8, 20), "AoE")],
          }),
        ],
      }),
    ];
    const overrides = {
      conferences: {
        setta: {
          editions: {
            2026: {
              link: "https://www.setta2026.sg",
              place: "Singapore",
              date_text: "December 2-4, 2026",
              deadlines: [{ kind: "paper", label: "Paper submission", date: "2026-05-10" }],
            },
          },
        },
      },
    };
    const out = applyOverrides(confs, overrides);
    const editions = Object.fromEntries(out[0].editions.map((e) => [e.year, e]));
    expect(editions[2026]).toBeDefined();
    const added = editions[2026];
    expect(added.estimated).toBe(false);
    expect(added.link).toBe("https://www.setta2026.sg");
    expect(added.place).toBe("Singapore");
    expect(added.deadlines[0].at_utc.getTime()).toBe(utc(2026, 5, 10, 23, 59, 59).getTime());
    expect(editions[2025].deadlines[0].at_utc.getTime()).toBe(utc(2025, 8, 20).getTime());
  });

  it("override adds missing edition with custom id, estimated: true, and top-level deadline keys", () => {
    const confs = [
      makeConference({
        key: "testconf",
        title: "TESTCONF",
        editions: [],
      }),
    ];
    const overrides = {
      conferences: {
        testconf: {
          editions: {
            2027: {
              id: "testconf27-custom",
              estimated: true,
              link: "https://testconf.org/2027",
              place: "Tokyo, Japan",
              deadline: "2027-02-15 23:59:00",
              notification: "2027-04-15 23:59:00",
            },
          },
        },
      },
    };
    const out = applyOverrides(confs, overrides);
    expect(out[0].editions.length).toBe(1);
    const ed = out[0].editions[0];
    expect(ed.edition_id).toBe("testconf27-custom");
    expect(ed.estimated).toBe(true);
    expect(ed.link).toBe("https://testconf.org/2027");
    expect(ed.place).toBe("Tokyo, Japan");
    expect(ed.deadlines.length).toBe(2);
    expect(ed.deadlines[0].kind).toBe("paper");
    expect(ed.deadlines[1].kind).toBe("notification");
  });

  it("override updates existing edition id and top-level deadline keys", () => {
    const confs = [
      makeConference({
        key: "testconf",
        title: "TESTCONF",
        editions: [
          makeEdition({
            year: 2026,
            edition_id: "testconf26-old",
            deadlines: [makeDeadline("paper", "Old deadline", utc(2026, 1, 1), "UTC")],
          }),
        ],
      }),
    ];
    const overrides = {
      conferences: {
        testconf: {
          editions: {
            2026: {
              id: "testconf26-new",
              paper_deadline: "2026-03-01 23:59:00",
            },
          },
        },
      },
    };
    const out = applyOverrides(confs, overrides);
    const ed = out[0].editions[0];
    expect(ed.edition_id).toBe("testconf26-new");
    expect(ed.deadlines.length).toBe(1);
    expect(ed.deadlines[0].kind).toBe("paper");
    expect(ed.deadlines[0].at_utc.toISOString()).toBe("2026-03-01T23:59:00.000Z");
  });

  it("override updates or deletes rank schemes cleanly (#288)", () => {
    const confs = [
      makeConference({
        key: "testrank",
        title: "TESTRANK",
        rank: { ccf: "B", core: "B", thcpl: "B" },
      }),
    ];
    const overrides = {
      conferences: {
        testrank: {
          rank: {
            ccf: null, // delete
            thcpl: "", // delete
            core: " A* ", // update & trim
            era: " A ", // add
          },
        },
      },
    };
    const out = applyOverrides(confs, overrides);
    expect(out[0].rank).toEqual({
      core: "A*",
      era: "A",
    });
    expect(out[0].rank.ccf).toBeUndefined();
    expect(out[0].rank.thcpl).toBeUndefined();
  });
});

describe("rollforward", () => {
  function staleConference(): Conference {
    return makeConference({
      key: "sc",
      title: "SC",
      upstream_sub: "DS",
      editions: [
        makeEdition({
          year: 2025,
          edition_id: "sc25",
          date_text: "November 16-21, 2025",
          event_start: new Date(Date.UTC(2025, 10, 16)),
          event_end: new Date(Date.UTC(2025, 10, 21)),
          deadlines: [
            makeDeadline("abstract", "Abstract", utc(2025, 9, 5, 11, 59, 59), "AoE"),
            makeDeadline("paper", "Paper", utc(2025, 9, 12, 11, 59, 0), "AoE"),
          ],
        }),
      ],
    });
  }

  it("adds one estimated edition", () => {
    const conf = staleConference();
    const out = byKey(rollforward([conf], TODAY, CONFIG)).sc;
    const estimated = out.editions.filter((ed) => ed.estimated);
    expect(estimated.length).toBe(1);
    expect(out.editions.filter((ed) => !ed.estimated).length).toBe(1);

    const paper = estimated[0].deadlines.filter((d) => d.kind === "paper");
    expect(paper.length).toBeGreaterThan(0);
    const expected = new Date(utc(2025, 9, 12, 11, 59, 0).getTime() + 364 * 86_400_000);
    expect(paper[0].at_utc.getTime()).toBe(expected.getTime());
  });

  it("estimated edition year agrees with the dates it carries", () => {
    const conf = makeConference({
      key: "sac",
      title: "SAC",
      upstream_sub: "SE",
      editions: [
        makeEdition({
          year: 2025,
          edition_id: "sac25",
          deadlines: [makeDeadline("paper", "R1", utc(2025, 1, 28, 11, 59, 59), "AoE")],
        }),
        makeEdition({
          year: 2026,
          edition_id: "sac26",
          deadlines: [
            makeDeadline("paper", "R1", utc(2025, 5, 12, 11, 59, 59), "AoE"),
            makeDeadline("paper", "R2", utc(2026, 2, 3, 11, 59, 59), "AoE", 2),
          ],
        }),
      ],
    });
    const out = byKey(rollforward([conf], TODAY, CONFIG)).sac;
    const estimated = out.editions.filter((ed) => ed.estimated);
    expect(estimated.length).toBe(1);
    const edition = estimated[0];
    expect(edition.deadlines.length).toBeGreaterThan(0);
    for (const dl of edition.deadlines) {
      expect(Math.abs(dl.at_utc.getUTCFullYear() - edition.year)).toBeLessThanOrEqual(1);
    }
  });

  it("does not touch a conference with a future edition", () => {
    const conf = makeConference({
      key: "nsdi",
      title: "NSDI",
      upstream_sub: "NW",
      editions: [
        makeEdition({
          year: 2026,
          edition_id: "nsdi26",
          deadlines: [makeDeadline("paper", "Paper", utc(2025, 9, 19, 3), "UTC-7")],
        }),
        makeEdition({
          year: 2027,
          edition_id: "nsdi27",
          deadlines: [makeDeadline("paper", "Paper", utc(2026, 9, 17, 3), "UTC-4", 2)],
        }),
      ],
    });
    const before = conf;
    const out = byKey(rollforward([conf], TODAY, CONFIG)).nsdi;
    expect(out.editions.some((ed) => ed.estimated)).toBe(false);
    expect(out.editions.length).toBe(before.editions.length);
    expect(new Set(out.editions.map((ed) => ed.year))).toEqual(new Set([2026, 2027]));
  });

  it("skips when only the event is still ahead", () => {
    const conf = makeConference({
      key: "imc",
      title: "IMC",
      upstream_sub: "NW",
      editions: [
        makeEdition({
          year: 2026,
          edition_id: "imc26",
          event_start: new Date(Date.UTC(2026, 9, 12)),
          event_end: new Date(Date.UTC(2026, 9, 16)),
          deadlines: [makeDeadline("paper", "Cycle 2", utc(2026, 4, 29, 11, 59, 59), "AoE", 2)],
        }),
      ],
    });
    const out = byKey(rollforward([conf], TODAY, CONFIG)).imc;
    expect(out.editions.some((ed) => ed.estimated)).toBe(false);
    expect(out.editions.map((ed) => ed.year)).toEqual([2026]);
  });

  it("leaves conferences without deadlines alone", () => {
    const conf = makeConference({
      key: "iots",
      title: "IOTS",
      editions: [
        makeEdition({
          year: 2025,
          edition_id: "iots25",
          event_start: new Date(Date.UTC(2025, 11, 3)),
          event_end: new Date(Date.UTC(2025, 11, 5)),
          source: "local",
        }),
      ],
    });
    const out = byKey(rollforward([conf], TODAY, CONFIG)).iots;
    expect(deadlinesOf(out).some((d) => d.kind === "paper")).toBe(false);
  });
});

describe("select", () => {
  it("keeps unranked conference when configured", () => {
    if (!((CONFIG.rank_filter as Record<string, unknown>)?.keep_if_no_rank ?? true)) {
      return;
    }
    const conf = makeConference({
      key: "isc-hpc",
      title: "ISC High Performance",
      rank: {},
      categories: ["hpc"],
      sources: ["local"],
      editions: [
        makeEdition({
          year: 2027,
          edition_id: "isc27",
          event_start: new Date(Date.UTC(2027, 5, 7)),
          event_end: new Date(Date.UTC(2027, 5, 11)),
          source: "local",
        }),
      ],
    });
    const out = select([conf], CONFIG);
    expect(out.map((c) => c.key)).toEqual(["isc-hpc"]);
  });

  it("drops a conference with neither deadline nor meeting date", () => {
    const bare = makeConference({
      key: "hpsr",
      title: "HPSR",
      categories: ["networking"],
      sources: ["local"],
    });
    const linkOnly = makeConference({
      key: "ieice-ns",
      title: "IEICE NS",
      categories: ["networking"],
      sources: ["local"],
      editions: [makeEdition({ year: 2026, edition_id: "ns26", source: "local" })],
    });
    const dated = makeConference({
      key: "p4-workshop",
      title: "P4 Workshop",
      categories: ["networking"],
      sources: ["local"],
      editions: [
        makeEdition({
          year: 2026,
          edition_id: "p4ws26",
          event_start: new Date(Date.UTC(2026, 9, 12)),
          event_end: new Date(Date.UTC(2026, 9, 12)),
          source: "local",
        }),
      ],
    });
    const endOnly = makeConference({
      key: "end-only-conf",
      title: "End Only Conf",
      categories: ["networking"],
      sources: ["local"],
      editions: [
        makeEdition({
          year: 2026,
          edition_id: "eoc26",
          event_start: null,
          event_end: new Date(Date.UTC(2026, 9, 15)),
          source: "local",
        }),
      ],
    });
    const kept = new Set(select([bare, linkOnly, dated, endOnly], CONFIG).map((c) => c.key));
    expect(kept).toEqual(new Set(["p4-workshop", "end-only-conf"]));
  });

  it("keeps taxonomy venues despite low rank", () => {
    const conf = makeConference({
      key: "systor",
      title: "SYSTOR",
      rank: { ccf: "C", core: "N" },
      categories: ["systems"],
      editions: [
        makeEdition({
          year: 2026,
          edition_id: "systor26",
          event_start: new Date(Date.UTC(2026, 8, 8)),
          event_end: new Date(Date.UTC(2026, 8, 9)),
          source: "ccfddl",
        }),
      ],
    });
    const bareCfg = {
      categories: { systems: "Systems" },
      rank_filter: { ccf: ["A", "B"], keep_if_no_rank: true, always_keep: [] },
      taxonomy: {},
    };
    expect(select([conf], bareCfg)).toEqual([]);
    const out = select([conf], CONFIG);
    expect(out.map((c) => c.key)).toEqual(["systor"]);
  });

  it("keeps every taxonomy venue key", () => {
    const venues: string[] = [];
    for (const rule of Object.values((CONFIG.taxonomy as Record<string, unknown>) ?? {})) {
      if (typeof rule === "object" && rule !== null) {
        venues.push(...(((rule as Record<string, unknown>).venues as string[] | null) ?? []));
      }
    }
    expect(venues.length).toBeGreaterThan(0);
    const confs = venues.map((key) =>
      makeConference({
        key,
        title: key.toUpperCase(),
        rank: { ccf: "C", core: "N" },
        categories: ["systems"],
        editions: [
          makeEdition({
            year: 2026,
            edition_id: `${key}26`,
            event_start: new Date(Date.UTC(2026, 8, 1)),
            event_end: new Date(Date.UTC(2026, 8, 2)),
            source: "ccfddl",
          }),
        ],
      }),
    );
    const kept = new Set(select(confs, CONFIG).map((c) => c.key));
    expect(kept).toEqual(new Set(venues));
  });

  it("keeps every extra.yaml key (venues 名指しは hasDates なしでも残る)", () => {
    const confs = parseFile(DEFAULT_PATH);
    expect(confs.length).toBeGreaterThan(0);
    const kept = new Set(select(confs, CONFIG).map((c) => c.key));
    const missing = confs.map((c) => c.key).filter((k) => !kept.has(k));
    expect(missing).toEqual([]);
  });
});

describe("rankOk", () => {
  it("matches case-insensitively on scheme names and rank values", () => {
    const conf1 = makeConference({
      key: "sigcomm",
      title: "SIGCOMM",
      rank: { ccf: "a", core: "a*" },
    });
    expect(rankOk(conf1, { CCF: ["A", "B"] }, false)).toBe(true);
    expect(rankOk(conf1, { CORE: ["A*"] }, false)).toBe(true);
    expect(rankOk(conf1, { ccf: ["B"] }, false)).toBe(false);
  });

  it("handles whitespace and absent rank tokens correctly", () => {
    const confNone = makeConference({
      key: "fake",
      title: "Fake",
      rank: { ccf: " NONE ", core: " - " },
    });
    // With absent rank tokens, conference is treated as having no rank
    expect(rankOk(confNone, { ccf: ["A"] }, true)).toBe(true);
    expect(rankOk(confNone, { ccf: ["A"] }, false)).toBe(false);
  });

  it("returns true when schemes are empty", () => {
    const conf = makeConference({
      key: "any",
      title: "Any",
    });
    expect(rankOk(conf, {}, false)).toBe(true);
  });
});

describe("sanitize_editions", () => {
  it("drops paper after event end", () => {
    const conf = makeConference({
      key: "icassp",
      title: "ICASSP",
      editions: [
        makeEdition({
          year: 2025,
          edition_id: "icassp25",
          event_start: new Date(Date.UTC(2025, 3, 6)),
          event_end: new Date(Date.UTC(2025, 3, 11)),
          deadlines: [
            makeDeadline("paper", "Paper submission", utc(2024, 9, 12, 6, 59, 59)),
            makeDeadline("paper", "Paper Submission", utc(2025, 9, 18, 6, 59, 59)),
            makeDeadline("camera_ready", "Camera", utc(2025, 5, 1, 0, 0, 0)),
          ],
        }),
      ],
    });
    const out = sanitizeEditions([conf])[0];
    const kindsTimes = out.editions[0].deadlines.map((d) => [d.kind, d.at_utc.getTime()] as const);
    expect(kindsTimes).toContainEqual(["paper", utc(2024, 9, 12, 6, 59, 59).getTime()]);
    expect(kindsTimes).not.toContainEqual(["paper", utc(2025, 9, 18, 6, 59, 59).getTime()]);
    expect(kindsTimes.some(([k]) => k === "camera_ready")).toBe(true);
  });

  it("sanitize after overrides in pipeline shape", () => {
    const conf = makeConference({
      key: "uai",
      title: "UAI",
      editions: [
        makeEdition({
          year: 2026,
          edition_id: "uai26",
          date_text: "August 17-21, 2025",
          event_start: new Date(Date.UTC(2025, 7, 17)),
          event_end: new Date(Date.UTC(2025, 7, 21)),
          deadlines: [makeDeadline("paper", "Paper submission", utc(2026, 2, 25, 11, 59, 59))],
        }),
      ],
    });
    const overrides = {
      conferences: {
        uai: {
          editions: {
            2026: {
              date_text: "August 17-21, 2026",
              event_start: "2026-08-17",
              event_end: "2026-08-21",
            },
          },
        },
      },
    };
    const out = sanitizeEditions(applyOverrides([conf], overrides))[0];
    const ed = out.editions[0];
    expect(ed.event_start?.toISOString().slice(0, 10)).toBe("2026-08-17");
    expect(ed.event_end?.toISOString().slice(0, 10)).toBe("2026-08-21");
    expect(ed.deadlines.length).toBe(1);
  });

  it("drops paper after event start when event_end is null", () => {
    const conf = makeConference({
      key: "one-day-symposium",
      title: "One Day Symposium",
      editions: [
        makeEdition({
          year: 2026,
          edition_id: "ods26",
          event_start: utc(2026, 5, 10, 0, 0, 0),
          event_end: null,
          deadlines: [
            makeDeadline("paper", "Valid Paper Submission", utc(2026, 3, 1, 23, 59, 59)),
            makeDeadline("paper", "Invalid Late Submission", utc(2026, 6, 1, 23, 59, 59)),
            makeDeadline("notification", "Notification", utc(2026, 4, 1, 23, 59, 59)),
          ],
        }),
      ],
    });
    const out = sanitizeEditions([conf])[0];
    const deadlines = out.editions[0].deadlines;
    expect(deadlines.map((d) => d.label)).toEqual(["Valid Paper Submission", "Notification"]);
  });
});

describe("local real edition suppresses same year estimate", () => {
  it("official 2026 CFP replaces a roll-forward estimate", () => {
    const upstream = makeConference({
      key: "log",
      title: "LOG",
      rank: { ccf: "N" },
      categories: ["ai"],
      sources: ["ccfddl"],
      editions: [
        makeEdition({
          year: 2025,
          edition_id: "log25",
          event_start: new Date(Date.UTC(2025, 11, 10)),
          event_end: new Date(Date.UTC(2025, 11, 12)),
          deadlines: [makeDeadline("paper", "Paper submission", utc(2025, 8, 30, 11, 59, 59))],
          source: "ccfddl",
        }),
      ],
    });
    const local = makeConference({
      key: "log",
      title: "LOG",
      categories: ["ai"],
      sources: ["local"],
      editions: [
        makeEdition({
          year: 2026,
          edition_id: "log26",
          event_start: new Date(Date.UTC(2026, 10, 20)),
          event_end: new Date(Date.UTC(2026, 10, 22)),
          deadlines: [makeDeadline("paper", "Full Paper", utc(2026, 8, 7, 11, 59, 59))],
          source: "local",
        }),
      ],
    });
    const conf = mergeSources([[local], [upstream]], CONFIG)[0];
    const rolled = rollforward([conf], TODAY, CONFIG)[0];
    const years = new Set(rolled.editions.map((e) => `${e.year}:${e.estimated}`));
    expect(years.has("2026:false")).toBe(true);
    expect(years.has("2026:true")).toBe(false);
  });
});

describe("apply_aliases", () => {
  it("rewrites keys before name matching", () => {
    const groups: Conference[][] = [
      [makeConference({ key: "kdd", title: "KDD", sources: ["ccfddl"] })],
      [makeConference({ key: "sigkdd", title: "SIGKDD", sources: ["aideadlines"] })],
    ];
    const aliased = applyAliases(groups, { sigkdd: "kdd" });
    expect(aliased[1][0].key).toBe("kdd");
  });

  it("handles null and undefined groups gracefully", () => {
    expect(applyAliases(null, {})).toEqual([]);
    expect(applyAliases(undefined, {})).toEqual([]);
    expect(applyAliases([[makeConference({ key: "kdd", title: "KDD" })]], null)).toHaveLength(1);
  });
});

describe("conferencesFromJson & defensive merge operations", () => {
  it("conferencesFromJson handles null, undefined, and non-object inputs", () => {
    expect(conferencesFromJson(null)).toEqual([]);
    expect(conferencesFromJson(undefined)).toEqual([]);
    expect(conferencesFromJson({} as any)).toEqual([]);
    expect(conferencesFromJson({ conferences: null } as any)).toEqual([]);
    expect(conferencesFromJson({ conferences: [null, undefined, "invalid", 123] } as any)).toEqual(
      [],
    );
  });

  it("conferencesFromJson parses valid and recovers from corrupted child elements", () => {
    const payload = {
      conferences: [
        {
          key: "test-conf",
          title: "Test Conf",
          full_name: "Test Conference",
          link: "https://example.com",
          rank: { ccf: "A" },
          tags: ["hpc"],
          categories: ["hpc"],
          sources: ["local"],
          editions: [
            null,
            {
              year: 2026,
              id: "test26",
              link: "https://example.com/26",
              place: "Tokyo",
              date_text: "2026-10-01",
              event_start: "2026-10-01",
              event_end: "2026-10-03",
              estimated: false,
              source: "local",
              deadlines: [
                null,
                {
                  kind: "paper",
                  label: "Submission",
                  utc: "2026-08-01 23:59:59",
                  tz_raw: "UTC",
                  round: 1,
                  comment: "Regular",
                },
                {
                  kind: "camera_ready",
                  label: "Camera Ready",
                  utc: "invalid-utc",
                },
              ],
            },
          ],
        },
      ],
    };
    const confs = conferencesFromJson(payload as any);
    expect(confs).toHaveLength(1);
    expect(confs[0].key).toBe("test-conf");
    expect(confs[0].editions).toHaveLength(1);
    expect(confs[0].editions[0].deadlines).toHaveLength(1);
    expect(confs[0].editions[0].deadlines[0].kind).toBe("paper");
  });

  it("merge functions handle null, undefined, and non-array arguments safely", () => {
    expect(mergeSources(null, {})).toEqual([]);
    expect(mergeSources(undefined, null as any)).toEqual([]);
    expect(select(null, {})).toEqual([]);
    expect(select(undefined, null as any)).toEqual([]);
    expect(rollforward(null, TODAY, {})).toEqual([]);
    expect(rollforward(undefined, TODAY, null as any)).toEqual([]);
  });

  it("rankOk handles null, undefined, and missing fields safely (#308)", () => {
    expect(rankOk(null, { ccf: ["A"] }, true)).toBe(false);
    expect(rankOk(undefined, { ccf: ["A"] }, false)).toBe(false);

    const conf = makeConference({ key: "test", title: "Test", rank: { ccf: "A" } });
    expect(rankOk(conf, null, true)).toBe(true);
    expect(rankOk(conf, undefined, true)).toBe(true);
    expect(rankOk(conf, {}, true)).toBe(true);
    expect(rankOk(conf, { ccf: ["A"] }, true)).toBe(true);
    expect(rankOk(conf, { ccf: ["B"] }, false)).toBe(false);
  });

  it("conferencesFromJson sanitizes rank removing null, empty, and 'null' values (#310)", () => {
    const payload = {
      conferences: [
        {
          key: "rank-test",
          title: "Rank Test",
          rank: { ccf: " A ", core: null, other: "", invalid: "null" },
        },
      ],
    };
    const confs = conferencesFromJson(payload as any);
    expect(confs).toHaveLength(1);
    expect(confs[0].rank).toEqual({ ccf: "A" });

    // applyOverrides removes rank when set to null / "" / "null"
    const patched = applyOverrides(confs, {
      conferences: {
        "rank-test": {
          rank: { ccf: "null", core: "A*" },
        },
      },
    });
    expect(patched[0].rank).toEqual({ core: "A*" });
  });

  it("classify, sanitizeEditions, and applyOverrides handle null and undefined safely (#332)", () => {
    expect(classify(null, null)).toEqual([]);
    expect(classify(undefined, undefined)).toEqual([]);
    expect(sanitizeEditions(null)).toEqual([]);
    expect(sanitizeEditions(undefined)).toEqual([]);
    expect(applyOverrides(null, null)).toEqual([]);
    expect(applyOverrides(undefined, undefined)).toEqual([]);
  });
});
