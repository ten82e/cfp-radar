/**
 * Verified-observation gate between primary extraction and merge (#504).
 *
 * 受入条件 (#504):
 *   1. 日付のみの一次証拠は正確な秒単位締切として公開されない
 *   2. ページ年が抽出年と衝突する観測は隔離され、確定出力から除外される
 *   3. 手動 override の後に低品質観測が来ても override の締切を保持する
 */

import { describe, expect, it, vi } from "vitest";
import { applyOverrides } from "../src/merge.ts";
import {
  extractObservationTime,
  resolveObservation,
  resolvePrimaryObservations,
} from "../src/sources/primary.ts";
import { makeConference, makeDeadline, makeEdition, utc } from "./helpers.ts";

function spyWarn(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process.stderr, "write").mockImplementation(() => true);
}

/** resolvePrimaryObservations 出力の edition パッチを型付きで取り出す。 */
function resolvedEditions(
  resolved: Record<string, unknown>,
  key: string,
): Record<string, Record<string, unknown>> {
  const conferences = resolved.conferences as Record<
    string,
    { editions?: Record<string, Record<string, unknown>> }
  >;
  return conferences[key].editions ?? {};
}

describe("extractObservationTime", () => {
  it("normalizes wall-clock times including 12h notation", () => {
    expect(extractObservationTime("Submission deadline May 10, 2026 11:59 p.m. AoE")).toBe(
      "23:59:00",
    );
    expect(extractObservationTime("due 2026-05-10 5:00 PM")).toBe("17:00:00");
    expect(extractObservationTime("deadline: 2026-08-14 12:00 noon AoE")).toBe("12:00:00"); // 'noon' は修飾語・数値時刻は正
    expect(extractObservationTime("August 16th, 2026 23:59:59")).toBe("23:59:59");
    expect(extractObservationTime("May 10, 2026")).toBeNull(); // 日付のみ
    expect(extractObservationTime("25:00")).toBeNull();
    expect(extractObservationTime(null)).toBeNull();
  });
});

describe("resolvePrimaryObservations (#504 acceptance)", () => {
  it("AC1: date-only evidence never becomes a second-level deadline", () => {
    const warnSpy = spyWarn();
    try {
      const primary = {
        conferences: {
          setta: {
            editions: {
              // 自動抽出の旧形: 日付のみ (時刻なし・tz なし)
              2026: {
                link: "https://example.org/setta26",
                deadlines: [{ kind: "paper", label: "Paper submission", date: "2026-10-10" }],
              },
            },
          },
        },
      };
      const resolved = resolvePrimaryObservations(primary);
      const edition = resolvedEditions(resolved, "setta")[2026];
      // deadlines キーごと消える → applyOverrides はメタデータのみパッチする
      expect("deadlines" in edition).toBe(false);
      expect(edition.link).toBe("https://example.org/setta26");
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("AC1 end-to-end: unresolved primary leaves the confirmed deadline standing", () => {
    const confs = [
      makeConference({
        key: "setta",
        title: "SETTA",
        editions: [
          makeEdition({
            year: 2026,
            edition_id: "setta26",
            deadlines: [makeDeadline("paper", "Paper", utc(2026, 10, 10, 11, 59, 0), "AoE")],
          }),
        ],
      }),
    ];
    const primary = resolvePrimaryObservations({
      conferences: {
        setta: {
          editions: {
            2026: {
              deadlines: [
                // 時刻ありだが tz 無し (unconfirmed) → 落ちる
                { kind: "paper", label: "Paper submission", date: "2026-10-10 23:59" },
              ],
            },
          },
        },
      },
    });
    const out = applyOverrides(confs, primary);
    expect(out[0].editions[0].deadlines).toHaveLength(1);
    expect(out[0].editions[0].deadlines[0].at_utc.getTime()).toBe(
      utc(2026, 10, 10, 11, 59, 0).getTime(),
    );
  });

  it("AC2: page-year conflicts are quarantined from confirmed output", () => {
    const warnSpy = spyWarn();
    try {
      const primary = {
        conferences: {
          oldconf: {
            editions: {
              2027: {
                deadlines: [
                  // 過去版ページの残骸: 2026 行が 2027 edition へ混入したケース
                  {
                    kind: "paper",
                    label: "Paper submission",
                    date: "2026-03-01 23:59",
                    tz: "AoE",
                  },
                ],
              },
            },
          },
        },
      };
      const resolved = resolvePrimaryObservations(primary);
      const edition = resolvedEditions(resolved, "oldconf")[2027];
      expect("deadlines" in edition).toBe(false);
      const joined = warnSpy.mock.calls.map((c: unknown[]) => String(c[0])).join("");
      expect(joined).toContain("quarantined");
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("AC3: a low-quality observation after a manual override keeps the override deadline", () => {
    const confs = [
      makeConference({
        key: "mmm",
        title: "MMM",
        editions: [
          makeEdition({
            year: 2027,
            edition_id: "mmm27",
            deadlines: [],
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
                  label: "Regular paper submission",
                  date: "2026-08-30 23:59",
                  tz: "AoE",
                },
              ],
            },
          },
        },
      },
    };
    // 手動 override 適用後に一次ソースの低品質観測 (日付のみ) が来る
    const primary = resolvePrimaryObservations({
      conferences: {
        mmm: {
          editions: {
            2027: {
              deadlines: [{ kind: "paper", label: "Paper submission", date: "2026-09-30" }],
            },
          },
        },
      },
    });
    let out = applyOverrides(confs, overrides);
    out = applyOverrides(out, primary);
    expect(out[0].editions[0].deadlines).toHaveLength(1);
    expect(out[0].editions[0].deadlines[0].label).toBe("Regular paper submission");
    expect(out[0].editions[0].deadlines[0].at_utc.getTime()).toBe(
      utc(2026, 8, 31, 11, 59, 0).getTime(),
    );
  });

  it("verified observations survive with normalized instants", () => {
    const primary = {
      conferences: {
        good: {
          editions: {
            2026: {
              deadlines: [
                { kind: "paper", label: "Paper submission", date: "2026-09-30 23:59", tz: "AoE" },
                { kind: "abstract", label: "Abstract", date: "2026-09-20 17:00", tz: "UTC" },
              ],
            },
          },
        },
      },
    };
    const resolved = resolvePrimaryObservations(primary);
    const rows = resolvedEditions(resolved, "good")[2026]?.deadlines ?? [];
    expect(rows).toEqual([
      {
        kind: "paper",
        label: "Paper submission",
        date: "2026-09-30 23:59:00",
        tz: "AoE",
        round: 1,
      },
      { kind: "abstract", label: "Abstract", date: "2026-09-20 17:00:00", tz: "UTC", round: 1 },
    ]);
  });

  it("mixed quality: verified rows replace, unverifiable rows are dropped", () => {
    const primary = {
      conferences: {
        mix: {
          editions: {
            2026: {
              deadlines: [
                { kind: "abstract", label: "Abstract", date: "2026-04-01 23:59", tz: "AoE" },
                { kind: "paper", label: "Paper (date only)", date: "2026-05-01" },
                {
                  kind: "paper",
                  label: "Paper (ambiguous tz)",
                  date: "2026-05-01 23:59",
                  tz: "CST",
                },
              ],
            },
          },
        },
      },
    };
    const warnSpy = spyWarn();
    try {
      const resolved = resolvePrimaryObservations(primary);
      const edition = resolvedEditions(resolved, "mix")[2026];
      const dl = edition.deadlines as unknown[] | undefined;
      expect(dl).toHaveLength(1);
      const first = dl?.[0] as Record<string, string> | undefined;
      expect(first?.kind).toBe("abstract");
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("degenerate inputs pass through harmlessly", () => {
    expect(resolvePrimaryObservations(null)).toEqual({});
    expect(resolvePrimaryObservations({})).toEqual({});
    expect(resolvePrimaryObservations({ conferences: {} })).toEqual({ conferences: {} });
    // deadlines 以外のパッチ (link 等) は温存される
    const metaOnly = resolvePrimaryObservations({
      conferences: { k: { editions: { 2026: { link: "https://x/" } } } },
    });
    expect(metaOnly).toEqual({
      conferences: { k: { editions: { 2026: { link: "https://x/" } } } },
    });
  });

  it("resolveObservation rejects unknown kinds into 'other' and keeps comments", () => {
    const ok = resolveObservation(
      {
        kind: "paper",
        label: "P",
        date: "2026-05-01",
        time: "23:59:00",
        tzRaw: "AoE",
        round: 1,
        rest: { comment: "official CFP" },
      },
      2026,
    );
    expect(ok).toEqual({
      kind: "paper",
      label: "P",
      date: "2026-05-01 23:59:00",
      tz: "AoE",
      round: 1,
      comment: "official CFP",
    });
    const odd = resolveObservation(
      {
        kind: "weird-kind",
        label: "W",
        date: "2026-05-01",
        time: "10:00",
        tzRaw: "JST",
        round: 1,
        rest: {},
      },
      2026,
    );
    expect(odd?.kind).toBe("other");
    // 年不一致は個行でも null
    const staleYear = resolveObservation(
      {
        kind: "paper",
        label: "P",
        date: "2025-05-01",
        time: "23:59:00",
        tzRaw: "AoE",
        round: 1,
        rest: {},
      },
      2026,
    );
    expect(staleYear).toBeNull();
  });
});

describe("applyOverrides merge-layer deadline guard (#504 P0-1)", () => {
  const existing = [
    makeConference({
      key: "netflow",
      title: "Network Flows",
      editions: [
        makeEdition({
          year: 2026,
          edition_id: "netflow26",
          deadlines: [makeDeadline("paper", "Paper", utc(2026, 9, 15, 11, 59, 0), "AoE")],
        }),
      ],
    }),
  ];

  it("keeps existing deadlines when a timezone-missing primary patch parses to nothing", () => {
    const out = applyOverrides(existing, {
      conferences: {
        netflow: {
          editions: {
            2026: {
              deadlines: [{ kind: "paper", label: "Paper submission", date: "2026-09-15 23:59" }],
            },
          },
        },
      },
    });
    expect(out[0].editions[0].deadlines).toHaveLength(1);
    expect(out[0].editions[0].deadlines[0].at_utc.getTime()).toBe(
      utc(2026, 9, 15, 11, 59, 0).getTime(),
    );
  });

  it("keeps existing deadlines when a timezone-ambiguous primary patch parses to nothing", () => {
    const out = applyOverrides(existing, {
      conferences: {
        netflow: {
          editions: {
            2026: {
              deadlines: [
                { kind: "paper", label: "Paper submission", date: "2026-09-15 23:59", tz: "CST" },
              ],
            },
          },
        },
      },
    });
    expect(out[0].editions[0].deadlines).toHaveLength(1);
    expect(out[0].editions[0].deadlines[0].tz_raw).toBe("AoE");
  });

  it("replaces existing deadlines when the primary patch is confirmed", () => {
    const out = applyOverrides(existing, {
      conferences: {
        netflow: {
          editions: {
            2026: {
              deadlines: [
                {
                  kind: "paper",
                  label: "Paper submission (extended)",
                  date: "2026-09-22 23:59",
                  tz: "AoE",
                },
              ],
            },
          },
        },
      },
    });
    expect(out[0].editions[0].deadlines).toHaveLength(1);
    expect(out[0].editions[0].deadlines[0].label).toBe("Paper submission (extended)");
    expect(out[0].editions[0].deadlines[0].at_utc.getTime()).toBe(
      utc(2026, 9, 23, 11, 59, 0).getTime(),
    );
  });

  it("empties deadlines only when clear_deadlines is true", () => {
    const out = applyOverrides(existing, {
      conferences: {
        netflow: {
          editions: {
            2026: { clear_deadlines: true },
          },
        },
      },
    });
    expect(out[0].editions[0].deadlines).toEqual([]);
  });

  it("does not add a new edition that has neither accepted deadlines nor event metadata", () => {
    const out = applyOverrides(existing, {
      conferences: {
        netflow: {
          editions: {
            2027: {
              deadlines: [{ kind: "paper", label: "Paper submission", date: "2027-01-15" }],
            },
          },
        },
      },
    });
    expect(out[0].editions.map((edition) => edition.year)).toEqual([2026]);
  });
});
