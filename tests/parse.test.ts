/**
 * parse_instant / parse_date_range / slug: SPEC.md section 3.
 * Ported from tests/test_parse.py.
 */

import { describe, expect, it } from "vitest";
import {
  parseDateRange,
  parseInstant,
  resetWarnings,
  roundOf,
  slug,
  warn,
  warningCounts,
} from "../src/model.ts";
import { editionOf, rankOf } from "../src/sources/aideadlines.ts";
import { utc } from "./helpers.ts";

describe("parse_instant", () => {
  it("AoE boundary case: SC26 '2026-04-08 23:59:00' AoE is 2026-04-09T11:59:00Z", () => {
    const got = parseInstant("2026-04-08 23:59:00", "AoE");
    expect(got?.getTime()).toBe(utc(2026, 4, 9, 11, 59, 0).getTime());
  });

  it("result is timezone-aware UTC", () => {
    const got = parseInstant("2026-02-06 23:59:59", "AoE");
    expect(got).not.toBeNull();
  });

  it("AoE end of day rolls into the next day", () => {
    expect(parseInstant("2026-02-06 23:59:59", "AoE")?.getTime()).toBe(
      utc(2026, 2, 7, 11, 59, 59).getTime(),
    );
  });

  it("UTC input is unchanged", () => {
    expect(parseInstant("2025-01-31 23:59:59", "UTC")?.getTime()).toBe(
      utc(2025, 1, 31, 23, 59, 59).getTime(),
    );
  });

  it("fixed negative offset: NSDI 2022 round 1", () => {
    expect(parseInstant("2021-03-04 20:59:59", "UTC-8")?.getTime()).toBe(
      utc(2021, 3, 5, 4, 59, 59).getTime(),
    );
  });

  it("positive offset", () => {
    expect(parseInstant("2024-04-28 23:59:59", "UTC+8")?.getTime()).toBe(
      utc(2024, 4, 28, 15, 59, 59).getTime(),
    );
  });

  it("DST zone winter and summer differ", () => {
    expect(parseInstant("2026-01-15 12:00:00", "PT")?.getTime()).toBe(
      utc(2026, 1, 15, 20, 0, 0).getTime(),
    );
    expect(parseInstant("2026-07-15 12:00:00", "PT")?.getTime()).toBe(
      utc(2026, 7, 15, 19, 0, 0).getTime(),
    );
  });

  it("minute precision form", () => {
    expect(parseInstant("2026-04-08 23:59", "UTC")?.getTime()).toBe(
      utc(2026, 4, 8, 23, 59, 0).getTime(),
    );
  });

  it("date only is end of day", () => {
    expect(parseInstant("2026-04-08", "UTC")?.getTime()).toBe(
      utc(2026, 4, 8, 23, 59, 59).getTime(),
    );
  });

  it("date only in AoE", () => {
    expect(parseInstant("2026-04-08", "AoE")?.getTime()).toBe(
      utc(2026, 4, 9, 11, 59, 59).getTime(),
    );
  });

  // Issue #28: out-of-range time components must be rejected, not normalized
  // by Date.UTC (e.g. 00:60 -> 01:00 when the calendar date stays unchanged).
  it.each([
    "2026-02-28 00:60:00",
    "2026-02-28 00:00:60",
    "2026-02-28 12:99:00",
    "2026-02-28 12:00:99",
    "2026-02-28 24:00:00",
  ])("full-precision invalid time %j returns null", (text) => {
    expect(parseInstant(text, "UTC")).toBeNull();
  });

  it.each(["2026-02-28 24:00", "2026-02-28 00:60", "2026-02-28 12:99"])(
    "minute-precision invalid time %j returns null",
    (text) => {
      expect(parseInstant(text, "UTC")).toBeNull();
    },
  );

  it.each([
    ["2026-02-28 00:00", utc(2026, 2, 28, 0, 0, 0).getTime()],
    ["2026-02-28 23:59", utc(2026, 2, 28, 23, 59, 0).getTime()],
    ["2026-02-28 23:59:59", utc(2026, 2, 28, 23, 59, 59).getTime()],
    ["2026-02-28", utc(2026, 2, 28, 23, 59, 59).getTime()],
  ] as Array<[string, number]>)("valid boundary %j parses unchanged", (text, expected) => {
    expect(parseInstant(text, "UTC")?.getTime()).toBe(expected);
  });

  it.each([
    ["2026-04-08T23:59:00.000Z", "UTC", "2026-04-08T23:59:00.000Z"],
    ["2026-04-08T23:59:00.123Z", "UTC", "2026-04-08T23:59:00.123Z"],
    ["2026-04-08T23:59:00.5Z", "UTC", "2026-04-08T23:59:00.500Z"],
    ["2026-04-08 23:59:00.123", "UTC", "2026-04-08T23:59:00.123Z"],
    ["2026-04-08 23:59:00.123456", "UTC", "2026-04-08T23:59:00.123Z"],
    ["2026-04-08T23:59:00.000Z", "AoE", "2026-04-09T11:59:00.000Z"],
  ] as Array<[string, string, string]>)(
    "parses ISO timestamp with fractional seconds: %s %s -> %s",
    (text, tz, expected) => {
      expect(parseInstant(text, tz)?.toISOString()).toBe(expected);
    },
  );

  it.each([
    "2026-02-28 24:00:00.000",
    "2026-02-28 12:60:00.000",
    "2026-02-28 12:00:60.000",
    "2026-02-30 12:00:00.000",
  ])("invalid time with fractional seconds %j returns null", (text) => {
    expect(parseInstant(text, "UTC")).toBeNull();
  });

  // R37 (2026-08-12) の教訓: Interactive HPC (SC26) で「8/15 23:59Z = 8/14 AoE」と
  // 暗算したため収録値が 1 日遅れた。正しくは AoE 8/14 23:59 = 8/15T11:59Z。
  // 表示日比較（"14th" vs "14th"）では 12h ずれを検出できない — utc/aoe 両フィールド
  // を機械照合すること。この表が変換の意味論を pin する。
  it.each([
    ["2026-08-14 23:59:00", "AoE", "2026-08-15T11:59:00.000Z"],
    ["2026-08-15 23:59:00", "AoE", "2026-08-16T11:59:00.000Z"],
    ["2026-08-15 23:59:00", "UTC", "2026-08-15T23:59:00.000Z"],
    ["2026-08-14 23:59:00", "UTC", "2026-08-14T23:59:00.000Z"],
  ] as Array<[string, string, string]>)("R37 trap: %s %s -> %s", (date, tz, expected) => {
    expect(parseInstant(date, tz)?.toISOString()).toBe(expected);
  });

  it("R37 trap: AoE Aug 14 23:59 and UTC Aug 15 23:59 are 12h apart, not a day", () => {
    const aoe = parseInstant("2026-08-14 23:59:00", "AoE")!.getTime();
    const utc = parseInstant("2026-08-15 23:59:00", "UTC")!.getTime();
    expect(utc - aoe).toBe(12 * 60 * 60 * 1000);
    // AoE 壁時計に戻すと 8/14 23:59 — 公式の「14th August」表示と一致するのはこちら。
    expect(new Date(aoe - 12 * 60 * 60 * 1000).toISOString()).toBe("2026-08-14T23:59:00.000Z");
    expect(new Date(utc - 12 * 60 * 60 * 1000).toISOString()).toBe("2026-08-15T11:59:00.000Z");
  });

  it.each(["TBD", "tbd", "", "   ", "N/A", "to be announced"])(
    "unparseable %j returns null",
    (text) => {
      expect(parseInstant(text, "AoE")).toBeNull();
    },
  );

  it("unparseable does not raise for missing timezone", () => {
    expect(parseInstant("TBD", null)).toBeNull();
  });

  // Issue #31: rejected numeric offsets use UTC and must not throw.
  it("rejected numeric timezone offset uses UTC and does not throw", () => {
    resetWarnings();
    expect(parseInstant("2026-01-15 12:00:00", "UTC+25")?.toISOString()).toBe(
      "2026-01-15T12:00:00.000Z",
    );
    resetWarnings();
  });
});

describe("parse_date_range", () => {
  it.each([
    ["August 17 - 21, 2026", 2026, "2026-08-17", "2026-08-21"],
    ["September 29 - October 3, 2025", 2025, "2025-09-29", "2025-10-03"],
    ["June 28 - July 2, 2026", 2026, "2026-06-28", "2026-07-02"],
    ["Oct 12-16, 2025", 2025, "2025-10-12", "2025-10-16"],
    ["November 15, 2026", 2026, "2026-11-15", "2026-11-15"],
    ["July 31-August 8, 2022", 2022, "2022-07-31", "2022-08-08"],
    ["June 29-July 3, 2024", 2024, "2024-06-29", "2024-07-03"],
    ["Jan 19 - Jan 24, 2025", 2025, "2025-01-19", "2025-01-24"],
    ["May 4-6, 2026", 2026, "2026-05-04", "2026-05-06"],
    ["November 30 - December 7, 2025", 2025, "2025-11-30", "2025-12-07"],
  ] as Array<[string, number, string, string]>)("%s", (text, year, s, e) => {
    const [start, end] = parseDateRange(text, year);
    expect(start?.toISOString().slice(0, 10)).toBe(s);
    expect(end?.toISOString().slice(0, 10)).toBe(e);
  });

  it("year crossing prefers explicit years", () => {
    const [start, end] = parseDateRange("December 28, 2025 - January 3, 2026", 2025);
    expect(start?.toISOString().slice(0, 10)).toBe("2025-12-28");
    expect(end?.toISOString().slice(0, 10)).toBe("2026-01-03");
  });

  it("fallback year used when text has none", () => {
    const [start, end] = parseDateRange("August 17 - 21", 2026);
    expect(start?.toISOString().slice(0, 10)).toBe("2026-08-17");
    expect(end?.toISOString().slice(0, 10)).toBe("2026-08-21");
  });

  it.each(["", "TBD", "Summer 2026", "to be determined"])(
    "unparseable range %j returns null pair",
    (text) => {
      expect(parseDateRange(text, 2026)).toEqual([null, null]);
    },
  );

  it("bare year is a silent year-only value", () => {
    resetWarnings();
    expect(parseDateRange("2026", 2026)).toEqual([null, null]);
    expect(warningCounts()).toEqual({});
    resetWarnings();
  });

  it("season-only text still warns as unparsable", () => {
    resetWarnings();
    expect(parseDateRange("Summer 2026", 2026)).toEqual([null, null]);
    expect(warningCounts()['unparsable event date "Summer 2026"']).toBe(1);
    resetWarnings();
  });

  it("range end is not before start", () => {
    const [start, end] = parseDateRange("September 29 - October 3, 2025", 2025);
    expect(start).not.toBeNull();
    expect(end).not.toBeNull();
    expect(start!.getTime()).toBeLessThanOrEqual(end!.getTime());
  });

  it("date range written with the word to", () => {
    const [s1, e1] = parseDateRange("September 29 to October 2, 2026", 2026);
    expect(s1?.toISOString().slice(0, 10)).toBe("2026-09-29");
    expect(e1?.toISOString().slice(0, 10)).toBe("2026-10-02");
    const [s2, e2] = parseDateRange("August 17 to 21, 2026", 2026);
    expect(s2?.toISOString().slice(0, 10)).toBe("2026-08-17");
    expect(e2?.toISOString().slice(0, 10)).toBe("2026-08-21");
    const [s3, e3] = parseDateRange("Oct 12-16, 2025", 2025);
    expect(s3?.toISOString().slice(0, 10)).toBe("2025-10-12");
    expect(e3?.toISOString().slice(0, 10)).toBe("2025-10-16");
  });

  it.each([
    "September 32, 2026",
    "September 0, 2026",
    "Sept 99, 2026",
    "March 32 - April, 2025",
    "August 32 - September 2, 2026",
  ])("impossible day %j fails closed to null pair", (text) => {
    const fallbackYear = 2026;
    expect(parseDateRange(text, fallbackYear)).toEqual([null, null]);
  });

  it.each(["September 31, 2026", "February 29, 2026", "April 31, 2026"])(
    "impossible calendar date %j fails closed and warns",
    (text) => {
      resetWarnings();
      expect(parseDateRange(text, 2026)).toEqual([null, null]);
      expect(warningCounts()[`unparsable event date ${JSON.stringify(text)}`]).toBe(1);
      resetWarnings();
    },
  );

  it("valid single date parses without warning", () => {
    resetWarnings();
    const [start, end] = parseDateRange("September 30, 2026", 2026);
    expect(start?.toISOString().slice(0, 10)).toBe("2026-09-30");
    expect(end?.toISOString().slice(0, 10)).toBe("2026-09-30");
    expect(warningCounts()).toEqual({});
    resetWarnings();
  });

  it("range with impossible start still warns", () => {
    resetWarnings();
    expect(parseDateRange("September 31 - October 2, 2026", 2026)).toEqual([null, null]);
    expect(warningCounts()[`unparsable event date "September 31 - October 2, 2026"`]).toBe(1);
    resetWarnings();
  });

  it("bare year and out-of-range day remain silent (regression #47/#48, #75)", () => {
    resetWarnings();
    expect(parseDateRange("2026", 2026)).toEqual([null, null]);
    expect(parseDateRange("Sept 99, 2026", 2026)).toEqual([null, null]);
    expect(warningCounts()).toEqual({});
    resetWarnings();
  });

  it("month only spans the whole month", () => {
    const [s1, e1] = parseDateRange("November, 2026", 2026);
    expect(s1?.toISOString().slice(0, 10)).toBe("2026-11-01");
    expect(e1?.toISOString().slice(0, 10)).toBe("2026-11-30");
    const [s2, e2] = parseDateRange("Oct, 2022", 2022);
    expect(s2?.toISOString().slice(0, 10)).toBe("2022-10-01");
    expect(e2?.toISOString().slice(0, 10)).toBe("2022-10-31");
    const [s3, e3] = parseDateRange("September , 2022", 2022);
    expect(s3?.toISOString().slice(0, 10)).toBe("2022-09-01");
    expect(e3?.toISOString().slice(0, 10)).toBe("2022-09-30");
  });

  it("month range without days: March-April, 2025", () => {
    const [s, e] = parseDateRange("March-April, 2025", 2025);
    expect(s?.toISOString().slice(0, 10)).toBe("2025-03-01");
    expect(e?.toISOString().slice(0, 10)).toBe("2025-04-30");
  });

  it("descending month range with year on second side crosses into previous year", () => {
    resetWarnings();
    const [s1, e1] = parseDateRange("October - February, 2026", 2026);
    expect(s1?.toISOString().slice(0, 10)).toBe("2025-10-01");
    expect(e1?.toISOString().slice(0, 10)).toBe("2026-02-28");
    const [s2, e2] = parseDateRange("December - January, 2026", 2026);
    expect(s2?.toISOString().slice(0, 10)).toBe("2025-12-01");
    expect(e2?.toISOString().slice(0, 10)).toBe("2026-01-31");
    expect(warningCounts()).toEqual({});
    resetWarnings();
  });

  it("ascending month range with year on second side stays in the same year", () => {
    const [s, e] = parseDateRange("November - December, 2026", 2026);
    expect(s?.toISOString().slice(0, 10)).toBe("2026-11-01");
    expect(e?.toISOString().slice(0, 10)).toBe("2026-12-31");
  });

  it("descending month range with no year still fails closed with a warning", () => {
    resetWarnings();
    expect(parseDateRange("December - January", 2026)).toEqual([null, null]);
    expect(warningCounts()[`unparsable event date "December - January"`]).toBe(1);
    resetWarnings();
  });

  it("month with TBD parenthetical: August 2027 (exact dates TBD)", () => {
    const [s, e] = parseDateRange("August 2027 (exact dates TBD)", 2027);
    expect(s?.toISOString().slice(0, 10)).toBe("2027-08-01");
    expect(e?.toISOString().slice(0, 10)).toBe("2027-08-31");
  });

  it("common month typo Septemper", () => {
    const [s, e] = parseDateRange("August 30 - Septemper 1, 2024", 2024);
    expect(s?.toISOString().slice(0, 10)).toBe("2024-08-30");
    expect(e?.toISOString().slice(0, 10)).toBe("2024-09-01");
  });

  it.each([
    ["2026-08-17 - 2026-08-21", 2026, "2026-08-17", "2026-08-21"],
    ["2026-08-17 to 2026-08-21", 2026, "2026-08-17", "2026-08-21"],
    ["2026/08/17 - 2026/08/21", 2026, "2026-08-17", "2026-08-21"],
    ["2026.08.17 - 2026.08.21", 2026, "2026-08-17", "2026-08-21"],
    ["2026-08-17 - 08-21", 2026, "2026-08-17", "2026-08-21"],
    ["2026-08-17 - 21", 2026, "2026-08-17", "2026-08-21"],
    ["2026-12-28 - 2027-01-03", 2026, "2026-12-28", "2027-01-03"],
    ["2026-12-28 - 01-03", 2026, "2026-12-28", "2027-01-03"],
    ["2026-08-17", 2026, "2026-08-17", "2026-08-17"],
    ["2026/08/17", 2026, "2026-08-17", "2026-08-17"],
  ] as Array<[string, number, string, string]>)(
    "numeric date range %s -> [%s, %s]",
    (text, fallbackYear, expectedStart, expectedEnd) => {
      resetWarnings();
      const [start, end] = parseDateRange(text, fallbackYear);
      expect(start?.toISOString().slice(0, 10)).toBe(expectedStart);
      expect(end?.toISOString().slice(0, 10)).toBe(expectedEnd);
      expect(warningCounts()).toEqual({});
      resetWarnings();
    },
  );

  it.each(["2026-02-30", "2026-08-21 - 2026-08-17", "2026-04-31 - 2026-05-02"])(
    "invalid numeric date %j fails closed and warns",
    (text) => {
      resetWarnings();
      expect(parseDateRange(text, 2026)).toEqual([null, null]);
      expect(warningCounts()[`unparsable event date ${JSON.stringify(text)}`]).toBe(1);
      resetWarnings();
    },
  );
});

describe("slug", () => {
  it.each([
    ["SIGCOMM", "sigcomm"],
    ["Hot Interconnects", "hot-interconnects"],
    ["IH&MMSec", "ih-mmsec"],
    ["SC", "sc"],
    ["NeurIPS", "neurips"],
    ["  Leading and trailing  ", "leading-and-trailing"],
    ["A -- B", "a-b"],
  ] as Array<[string, string]>)("%s -> %s", (title, expected) => {
    expect(slug(title)).toBe(expected);
  });

  it("is idempotent", () => {
    expect(slug(slug("Hot Interconnects"))).toBe(slug("Hot Interconnects"));
  });
});

describe("aideadlines edition parsing", () => {
  it("lifts stale year in date_text", () => {
    const ed = editionOf({
      year: 2026,
      id: "uai26",
      date: "August 17-21, 2025",
      deadline: "2026-02-25 23:59:59",
      timezone: "AoE",
      city: "Amsterdam",
      country: "Netherlands",
    });
    expect(ed).not.toBeNull();
    expect(ed?.event_start?.toISOString().slice(0, 10)).toBe("2026-08-17");
    expect(ed?.event_end?.toISOString().slice(0, 10)).toBe("2026-08-21");
    expect(ed?.date_text).toContain("2026");
  });

  it("prefers date_text when start year disagrees", () => {
    const ed = editionOf({
      year: 2026,
      id: "icassp26",
      date: "May 4-8, 2026",
      start: "2025-05-04",
      end: "2025-05-08",
      deadlines: [
        {
          type: "submission",
          label: "Paper Submission",
          date: "2025-09-18 08:59:59",
          timezone: "GMT+02",
        },
      ],
    });
    expect(ed).not.toBeNull();
    expect(ed?.event_start?.toISOString().slice(0, 10)).toBe("2026-05-04");
    expect(ed?.event_end?.toISOString().slice(0, 10)).toBe("2026-05-08");
  });
});

describe("warning counts", () => {
  it("tallies unparsable event dates", () => {
    resetWarnings();
    expect(warningCounts()).toEqual({});
    parseDateRange("TBD", 2026);
    parseDateRange("TBD", 2026);
    warn("custom");
    const counts = warningCounts();
    expect(counts['unparsable event date "TBD"']).toBe(2);
    expect(counts.custom).toBe(1);
    resetWarnings();
    expect(warningCounts()).toEqual({});
  });
});

describe("roundOf", () => {
  it.each([
    ["Round 1 Paper Submission", 1, 1],
    ["Round 2 Deadline", 1, 2],
    ["Round #3", 1, 3],
    ["Cycle 1 Submission", 1, 1],
    ["Cycle 2 Deadline", 1, 2],
    ["Cycle #3", 1, 3],
    ["1st Round Paper", 1, 1],
    ["2nd Round Paper", 1, 2],
    ["3rd Cycle Submission", 1, 3],
    ["4th round deadline", 1, 4],
    ["R1 Paper Submission", 1, 1],
    ["R2 Abstract", 1, 2],
    ["(R3) Notification", 1, 3],
    ["[R4] Submission", 1, 4],
    ["R2: Paper deadline", 1, 2],
    ["Regular Paper", 1, 1],
    ["Paper Submission", 2, 2],
    ["Summer 2026", 1, 1],
    ["Round 0", 1, 1],
    ["", 1, 1],
    [null, 1, 1],
    [undefined, 1, 1],
  ] as Array<[string | null | undefined, number, number]>)(
    "roundOf(%j, %d) -> %d",
    (label, fallback, expected) => {
      expect(roundOf(label, fallback)).toBe(expected);
    },
  );
});

describe("aideadlines rankOf", () => {
  it("parses comma-separated string", () => {
    expect(rankOf("CCF: A, CORE: A*, THCPL: A")).toEqual({
      ccf: "A",
      core: "A*",
      thcpl: "A",
    });
  });

  it("parses object/map rankings from YAML", () => {
    expect(rankOf({ CCF: "A", core: "A*", CORE: "A*" })).toEqual({
      ccf: "A",
      core: "A*",
    });
  });

  it("parses array of strings and objects", () => {
    expect(rankOf(["CCF: A", { core: "A*" }])).toEqual({
      ccf: "A",
      core: "A*",
    });
  });

  it("handles null, undefined, empty, and malformed values", () => {
    expect(rankOf(null)).toEqual({});
    expect(rankOf(undefined)).toEqual({});
    expect(rankOf("")).toEqual({});
    expect(rankOf("no colon here, invalid")).toEqual({});
    expect(rankOf({ ccf: null, core: "" })).toEqual({});
  });
});
