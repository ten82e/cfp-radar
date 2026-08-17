/**
 * parse_instant / parse_date_range / slug: SPEC.md section 3.
 * Ported from tests/test_parse.py.
 */

import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parsePrimaryArgs } from "../src/fetch-primary.ts";
import {
  monthOf,
  parseDateRange,
  parseInstant,
  resetWarnings,
  roundOf,
  slug,
  warn,
  warningCounts,
} from "../src/model.ts";
import {
  deadlinesOf as aideadlinesDeadlinesOf,
  parseTree as aideadlinesParseTree,
  editionOf,
  rankOf,
} from "../src/sources/aideadlines.ts";
import { cacheSlot, extractedRoot } from "../src/sources/base.ts";
import {
  conferenceOf as ccfddlConferenceOf,
  deadlinesOf as ccfddlDeadlinesOf,
  editionOf as ccfddlEditionOf,
  parseTree as ccfddlParseTree,
} from "../src/sources/ccfddl.ts";
import {
  deadlinesOf as localDeadlinesOf,
  editionOf as localEditionOf,
  parseFile as localParseFile,
} from "../src/sources/local.ts";
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

  it.each([
    ["2026年8月17日 - 2026年8月21日", 2026, "2026-08-17", "2026-08-21"],
    ["2026年8月17日〜21日", 2026, "2026-08-17", "2026-08-21"],
    ["2026年8月17日〜8月21日", 2026, "2026-08-17", "2026-08-21"],
    ["2026年8月30日〜9月2日", 2026, "2026-08-30", "2026-09-02"],
    ["2026年12月28日〜2027年1月3日", 2026, "2026-12-28", "2027-01-03"],
    ["2026年12月28日〜1月3日", 2026, "2026-12-28", "2027-01-03"],
    ["2026年8月17日", 2026, "2026-08-17", "2026-08-17"],
    ["8月17日", 2026, "2026-08-17", "2026-08-17"],
    ["2026年8月", 2026, "2026-08-01", "2026-08-31"],
    ["2026年8月〜9月", 2026, "2026-08-01", "2026-09-30"],
    ["２０２６年８月１７日〜２１日", 2026, "2026-08-17", "2026-08-21"],
  ] as Array<[string, number, string, string]>)(
    "japanese date range %s -> [%s, %s]",
    (text, fallbackYear, expectedStart, expectedEnd) => {
      resetWarnings();
      const [start, end] = parseDateRange(text, fallbackYear);
      expect(start?.toISOString().slice(0, 10)).toBe(expectedStart);
      expect(end?.toISOString().slice(0, 10)).toBe(expectedEnd);
      expect(warningCounts()).toEqual({});
      resetWarnings();
    },
  );

  it.each(["2026年2月30日", "2026年8月25日〜20日", "2026年9月31日", "2026年8月32日〜9月2日"])(
    "invalid japanese date %j fails closed and warns",
    (text) => {
      resetWarnings();
      expect(parseDateRange(text, 2026)).toEqual([null, null]);
      expect(warningCounts()[`unparsable event date ${JSON.stringify(text)}`]).toBe(1);
      resetWarnings();
    },
  );

  it("monthOf parses month names, standard abbreviations, and known typos without matching city names (#278)", () => {
    expect(monthOf("August")).toBe(8);
    expect(monthOf("Aug")).toBe(8);
    expect(monthOf("Sept")).toBe(9);
    expect(monthOf("September")).toBe(9);
    expect(monthOf("Septemper")).toBe(9); // APWeb-WAIM 2024 typo
    expect(monthOf("January")).toBe(1);
    expect(monthOf("Jan")).toBe(1);
    expect(monthOf("Augusta")).toBeNull(); // City name is not August
    expect(monthOf("Marcus")).toBeNull();
    expect(monthOf("Novella")).toBeNull();
    expect(monthOf("Apricot")).toBeNull();
    expect(monthOf("Janina")).toBeNull();
  });

  it("parseDateRange parses event dates without false positive month matching on city names (#278)", () => {
    resetWarnings();
    const [start, end] = parseDateRange("March 10-12, 2026, Augusta, GA", 2026);
    expect(start?.toISOString().slice(0, 10)).toBe("2026-03-10");
    expect(end?.toISOString().slice(0, 10)).toBe("2026-03-12");
    expect(warningCounts()).toEqual({});
    resetWarnings();
  });
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
    ["Phase 1 Paper Submission", 1, 1],
    ["Phase 2 Deadline", 1, 2],
    ["Phase #3", 1, 3],
    ["1st Phase Submission", 1, 1],
    ["2nd Phase Deadline", 1, 2],
    ["Stage 1 Paper", 1, 1],
    ["Stage 2 Submission", 1, 2],
    ["3rd Stage", 1, 3],
    ["Round I Paper", 1, 1],
    ["Round II Submission", 1, 2],
    ["Round III Deadline", 1, 3],
    ["Round IV", 1, 4],
    ["Round V", 1, 5],
    ["Round VI Paper", 1, 6],
    ["Cycle VII Submission", 1, 7],
    ["Phase VIII Deadline", 1, 8],
    ["Round IX", 1, 9],
    ["Cycle X", 1, 10],
    ["Phase II Submission", 1, 2],
    ["Cycle III Deadline", 1, 3],
    ["第1回締切", 1, 1],
    ["第2回締切", 1, 2],
    ["第3次募集", 1, 3],
    ["2次締切", 1, 2],
    ["第二次募集", 1, 2],
    ["第２回原稿提出", 1, 2],
    ["3回目締切", 1, 3],
    ["第1期募集", 1, 1],
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

  it("extracts legacy deadline fields including paper_deadline, notification, and camera_ready", () => {
    const raw = {
      timezone: "UTC",
      paper_deadline: "2026-05-15 23:59:59",
      notification: "2026-07-01 23:59:59",
      camera_ready: "2026-07-20 23:59:59",
    };
    const dls = aideadlinesDeadlinesOf(raw);
    expect(dls.length).toBe(3);
    expect(dls.map((d) => d.kind)).toEqual(["paper", "notification", "camera_ready"]);
  });

  it("parseTree gracefully returns empty array for non-existent directory", () => {
    expect(aideadlinesParseTree("/tmp/nonexistent-aideadlines-12345")).toEqual([]);
  });
});

describe("local source utilities and defensive parsing", () => {
  it("deadlinesOf handles null, undefined, and non-object inputs safely", () => {
    expect(localDeadlinesOf(null)).toEqual([]);
    expect(localDeadlinesOf(undefined)).toEqual([]);
    expect(localDeadlinesOf({} as any)).toEqual([]);
    expect(localDeadlinesOf({ deadlines: [null, undefined, "invalid"] } as any)).toEqual([]);
  });

  it("deadlinesOf extracts legacy camera_ready fields (final_paper, final_submission)", () => {
    const raw1 = {
      timezone: "UTC",
      final_paper: "2026-06-01 23:59:59",
    };
    const dls1 = localDeadlinesOf(raw1);
    expect(dls1).toHaveLength(1);
    expect(dls1[0].kind).toBe("camera_ready");

    const raw2 = {
      timezone: "UTC",
      final_submission: "2026-06-15 23:59:59",
    };
    const dls2 = localDeadlinesOf(raw2);
    expect(dls2).toHaveLength(1);
    expect(dls2[0].kind).toBe("camera_ready");
  });

  it("editionOf and parseFile handle null/undefined/invalid arguments defensively", () => {
    expect(localEditionOf(null, "test")).toBeNull();
    expect(localEditionOf(undefined, "test")).toBeNull();
    expect(localEditionOf({ year: "invalid" }, "test")).toBeNull();

    expect(localParseFile(null)).toEqual([]);
    expect(localParseFile(undefined)).toEqual([]);
    expect(localParseFile("/tmp/nonexistent-extra-12345.yaml")).toEqual([]);
  });
});

describe("base source utilities", () => {
  it("cacheSlot replaces slashes in repo and ref", () => {
    expect(cacheSlot("/tmp/cache", "org/sub/repo", "refs/heads/feature/test")).toBe(
      "/tmp/cache/org__sub__repo__refs__heads__feature__test",
    );
  });

  it("extractedRoot returns null on non-existent path or non-directory", () => {
    expect(extractedRoot("/tmp/nonexistent-slot-12345")).toBeNull();
  });
});

describe("ccfddl parsing", () => {
  it("parses timeline with multiple rounds and alternative key names", () => {
    const timeline = [
      {
        abstract_deadline: "2026-01-15 23:59:59",
        deadline: "2026-01-22 23:59:59",
        comment: "Round 1",
      },
      {
        "abstract deadline": "2026-06-15 23:59:59",
        paper_deadline: "2026-06-22 23:59:59",
        comment: "Round 2",
      },
      {
        abstract: "2026-09-01 23:59:59",
        submission_deadline: "2026-09-08 23:59:59",
      },
    ];
    const dls = ccfddlDeadlinesOf(timeline, "AoE");
    expect(dls.length).toBe(6);
    expect(dls[0].kind).toBe("abstract");
    expect(dls[0].round).toBe(1);
    expect(dls[0].comment).toBe("Round 1");
    expect(dls[1].kind).toBe("paper");
    expect(dls[1].round).toBe(1);
    expect(dls[2].kind).toBe("abstract");
    expect(dls[2].round).toBe(2);
    expect(dls[3].kind).toBe("paper");
    expect(dls[3].round).toBe(2);
    expect(dls[4].kind).toBe("abstract");
    expect(dls[4].round).toBe(3);
    expect(dls[5].kind).toBe("paper");
    expect(dls[5].round).toBe(3);
  });

  it("falls back to top-level deadline if timeline is absent or empty", () => {
    const rawEdition = {
      year: 2026,
      id: "sigcomm26",
      timezone: "AoE",
      date: "August 17-21, 2026",
      abstract_deadline: "2026-01-31 23:59:59",
      deadline: "2026-02-06 23:59:59",
      place: "Denver, Colorado",
    };
    const ed = ccfddlEditionOf(rawEdition);
    expect(ed).not.toBeNull();
    expect(ed?.deadlines.length).toBe(2);
    expect(ed?.deadlines[0].kind).toBe("abstract");
    expect(ed?.deadlines[1].kind).toBe("paper");
    expect(ed?.event_start?.toISOString().slice(0, 10)).toBe("2026-08-17");
  });

  it("parses conference object with rank and editions", () => {
    const rawConf = {
      title: "SIGCOMM",
      description: "ACM SIGCOMM Conference",
      sub: "NW",
      rank: { ccf: "A", CORE: "A*" },
      dblp: "conf/sigcomm",
      confs: [
        {
          year: 2026,
          id: "sigcomm26",
          link: "https://conferences.sigcomm.org/sigcomm/2026/",
          date: "August 17-21, 2026",
          timeline: [{ deadline: "2026-02-06 23:59:59" }],
        },
      ],
    };
    const conf = ccfddlConferenceOf(rawConf);
    expect(conf).not.toBeNull();
    expect(conf?.key).toBe("sigcomm");
    expect(conf?.title).toBe("SIGCOMM");
    expect(conf?.full_name).toBe("ACM SIGCOMM Conference");
    expect(conf?.rank).toEqual({ ccf: "A", core: "A*" });
    expect(conf?.link).toBe("https://conferences.sigcomm.org/sigcomm/2026/");
    expect(conf?.editions.length).toBe(1);
    expect(conf?.editions[0].deadlines.length).toBe(1);
  });

  it("inherits parent timezone and falls back edition_id to year when omitted", () => {
    const rawConf = {
      title: "FAST",
      tz: "AoE",
      confs: [
        {
          year: 2027,
          date: "February 23-25, 2027",
          timeline: [{ deadline: "2026-09-24 23:59:59" }],
        },
      ],
    };
    const conf = ccfddlConferenceOf(rawConf);
    expect(conf).not.toBeNull();
    expect(conf?.editions.length).toBe(1);
    const ed = conf!.editions[0];
    expect(ed.edition_id).toBe("2027");
    expect(ed.deadlines.length).toBe(1);
    expect(ed.deadlines[0].tz_raw).toBe("AoE");
    expect(ed.deadlines[0].at_utc.toISOString()).toBe("2026-09-25T11:59:59.000Z");
  });

  it("timeline entry specific timezone overrides edition timezone", () => {
    const timeline = [
      { deadline: "2026-04-01 23:59:59", tz: "UTC" },
      { deadline: "2026-04-01 23:59:59", tz: "AoE" },
    ];
    const dls = ccfddlDeadlinesOf(timeline, "UTC-8");
    expect(dls.length).toBe(2);
    expect(dls[0].tz_raw).toBe("UTC");
    expect(dls[0].at_utc.toISOString()).toBe("2026-04-01T23:59:59.000Z");
    expect(dls[1].tz_raw).toBe("AoE");
    expect(dls[1].at_utc.toISOString()).toBe("2026-04-02T11:59:59.000Z");
  });

  it("parses edition with tz alias instead of timezone", () => {
    const rawEdition = {
      year: 2026,
      tz: "AoE",
      deadline: "2026-05-15 23:59:59",
    };
    const ed = ccfddlEditionOf(rawEdition);
    expect(ed).not.toBeNull();
    expect(ed?.deadlines[0].tz_raw).toBe("AoE");
    expect(ed?.deadlines[0].at_utc.toISOString()).toBe("2026-05-16T11:59:59.000Z");
  });

  it("extracts camera ready deadlines from final paper/submission variants", () => {
    const raw1 = {
      year: 2026,
      timezone: "UTC",
      "final paper": "2026-07-01 23:59:59",
    };
    const ed1 = ccfddlEditionOf(raw1);
    expect(ed1?.deadlines).toHaveLength(1);
    expect(ed1?.deadlines[0].kind).toBe("camera_ready");

    const raw2 = {
      year: 2026,
      timezone: "UTC",
      final_submission: "2026-07-15 23:59:59",
    };
    const ed2 = ccfddlEditionOf(raw2);
    expect(ed2?.deadlines).toHaveLength(1);
    expect(ed2?.deadlines[0].kind).toBe("camera_ready");
  });

  it("handles null, undefined, and invalid arguments defensively", () => {
    expect(ccfddlEditionOf(null)).toBeNull();
    expect(ccfddlEditionOf(undefined)).toBeNull();
    expect(ccfddlEditionOf({ year: "invalid" })).toBeNull();

    expect(ccfddlConferenceOf(null)).toBeNull();
    expect(ccfddlConferenceOf(undefined)).toBeNull();
    expect(ccfddlConferenceOf({ title: "" })).toBeNull();

    expect(ccfddlParseTree(null)).toEqual([]);
    expect(ccfddlParseTree(undefined)).toEqual([]);
    expect(ccfddlParseTree("/tmp/nonexistent-ccfddl-12345")).toEqual([]);
  });

  it("extracts notification and camera_ready from timeline and top-level fallback", () => {
    const timeline = [
      {
        abstract_deadline: "2026-05-01 23:59:59",
        deadline: "2026-05-15 23:59:59",
        notification_deadline: "2026-07-01 23:59:59",
        camera_ready_deadline: "2026-07-20 23:59:59",
        tz: "UTC",
      },
    ];
    const dls = ccfddlDeadlinesOf(timeline, "UTC");
    expect(dls.length).toBe(4);
    expect(dls.map((d) => d.kind)).toEqual(["abstract", "paper", "notification", "camera_ready"]);

    const fallbackEdition = {
      year: 2026,
      timezone: "UTC",
      notification: "2026-08-01 23:59:59",
      camera_ready: "2026-08-20 23:59:59",
    };
    const fallbackDls = ccfddlDeadlinesOf([], "UTC", fallbackEdition);
    expect(fallbackDls.length).toBe(2);
    expect(fallbackDls.map((d) => d.kind)).toEqual(["notification", "camera_ready"]);
  });

  it("parseTree gracefully returns empty array for non-existent directory", () => {
    expect(ccfddlParseTree("/tmp/nonexistent-ccfddl-tree-12345")).toEqual([]);
  });
});

describe("local source parsing", () => {
  it("inherits timezone from parent edition when deadline entry has no timezone", () => {
    const raw = {
      tz: "AoE",
      deadlines: [{ date: "2026-05-15 23:59:00", kind: "paper" }],
    };
    const dls = localDeadlinesOf(raw);
    expect(dls.length).toBe(1);
    expect(dls[0].tz_raw).toBe("AoE");
    expect(dls[0].at_utc.toISOString()).toBe("2026-05-16T11:59:00.000Z");
  });

  it("falls back to top-level deadline/abstract_deadline when deadlines array is absent", () => {
    const raw = {
      timezone: "UTC",
      paper_deadline: "2026-05-15 23:59:00",
      abstract_deadline: "2026-05-01 23:59:00",
      notification: "2026-07-01 23:59:00",
      camera_ready: "2026-07-15 23:59:00",
      rebuttal_end: "2026-06-15 23:59:00",
      registration: "2026-08-01 23:59:00",
    };
    const dls = localDeadlinesOf(raw);
    expect(dls.length).toBe(6);
    expect(dls.map((d) => d.kind)).toEqual([
      "abstract",
      "paper",
      "notification",
      "camera_ready",
      "rebuttal_end",
      "registration",
    ]);
  });

  it("parses valid local edition and propagates estimated flag", () => {
    const rawEdition = {
      year: 2026,
      id: "resound26",
      place: "Europe",
      date_text: "September 14-16, 2026",
      deadline: "2026-06-01 23:59:00",
      tz: "AoE",
      estimated: true,
    };
    const ed = localEditionOf(rawEdition, "resound");
    expect(ed).not.toBeNull();
    expect(ed?.year).toBe(2026);
    expect(ed?.edition_id).toBe("resound26");
    expect(ed?.event_start?.toISOString().slice(0, 10)).toBe("2026-09-14");
    expect(ed?.deadlines.length).toBe(1);
    expect(ed?.deadlines[0].kind).toBe("paper");
    expect(ed?.estimated).toBe(true);
  });

  it("parseFile ignores null, undefined, and empty rank values without stringifying to 'null' (#288)", () => {
    const tmp = "/tmp/test-null-rank-parse.yaml";
    writeFileSync(
      tmp,
      `
conferences:
  - key: test-rank-conf
    title: Test Rank Conference
    rank:
      ccf: null
      core: " A* "
      thcpl: ""
    editions:
      - year: 2026
        deadline: "2026-05-15 23:59:00"
`,
    );
    try {
      const confs = localParseFile(tmp);
      expect(confs.length).toBe(1);
      expect(confs[0].rank).toEqual({ core: "A*" });
      expect(confs[0].rank.ccf).toBeUndefined();
      expect(confs[0].rank.thcpl).toBeUndefined();
    } finally {
      if (existsSync(tmp)) unlinkSync(tmp);
    }
  });
});

describe("aideadlines deadlinesOf parsing", () => {
  it("inherits timezone from parent edition when deadline entry has no timezone", () => {
    const raw = {
      tz: "AoE",
      deadlines: [{ date: "2026-05-15 23:59:00", kind: "paper", comment: "main track" }],
    };
    const dls = aideadlinesDeadlinesOf(raw);
    expect(dls.length).toBe(1);
    expect(dls[0].kind).toBe("paper");
    expect(dls[0].tz_raw).toBe("AoE");
    expect(dls[0].comment).toBe("main track");
    expect(dls[0].at_utc.toISOString()).toBe("2026-05-16T11:59:00.000Z");
  });

  it("handles legacy top-level abstract_deadline and deadline with timezone/tz", () => {
    const raw = {
      tz: "UTC",
      deadline: "2026-05-15 23:59:00",
      abstract_deadline: "2026-05-01 23:59:00",
    };
    const dls = aideadlinesDeadlinesOf(raw);
    expect(dls.length).toBe(2);
    expect(dls[0].kind).toBe("abstract");
    expect(dls[1].kind).toBe("paper");
  });

  it("falls back to legacy top-level deadlines when deadlines array is empty", () => {
    const raw = {
      tz: "AoE",
      deadlines: [],
      deadline: "2026-06-01 23:59:00",
    };
    const dls = aideadlinesDeadlinesOf(raw);
    expect(dls.length).toBe(1);
    expect(dls[0].kind).toBe("paper");
    expect(dls[0].tz_raw).toBe("AoE");
    expect(dls[0].at_utc.toISOString()).toBe("2026-06-02T11:59:00.000Z");
  });

  it("falls back edition_id to String(year) when raw.id is omitted", () => {
    const raw = {
      year: 2026,
      link: "https://example.com/2026",
    };
    const ed = editionOf(raw);
    expect(ed).not.toBeNull();
    expect(ed?.year).toBe(2026);
    expect(ed?.edition_id).toBe("2026");
  });

  it("extracts place prioritizing raw.place and cleanly joining city/country (#274)", () => {
    // 1. raw.place priority
    expect(
      editionOf({
        year: 2026,
        place: "Honolulu, Hawaii",
        city: "Honolulu",
        country: "USA",
      })?.place,
    ).toBe("Honolulu, Hawaii");

    // 2. city + country combination
    expect(
      editionOf({
        year: 2026,
        city: "Honolulu",
        country: "USA",
      })?.place,
    ).toBe("Honolulu, USA");

    // 3. whitespace-only city does not produce leading comma
    expect(
      editionOf({
        year: 2026,
        city: "   ",
        country: "USA",
      })?.place,
    ).toBe("USA");

    // 4. whitespace-only country does not produce trailing comma
    expect(
      editionOf({
        year: 2026,
        city: "Tokyo",
        country: "   ",
      })?.place,
    ).toBe("Tokyo");

    // 5. whitespace-only both produces empty string
    expect(
      editionOf({
        year: 2026,
        city: "   ",
        country: "   ",
      })?.place,
    ).toBe("");
  });

  it("aideadlines rankOf sanitizes null, empty strings, and 'null' values (#300)", () => {
    expect(rankOf({ ccf: " A ", core: null, other: "", invalid: "null" })).toEqual({
      ccf: "A",
    });
    expect(rankOf("CCF: A, CORE: null, OTHER: ")).toEqual({ ccf: "A" });
    expect(rankOf(["CCF: A", "CORE: null", { THCPL: " A* " }])).toEqual({
      ccf: "A",
      thcpl: "A*",
    });
    expect(rankOf(null)).toEqual({});
    expect(rankOf(undefined)).toEqual({});
  });

  it("ccfddl conferenceOf sanitizes rank values removing empty and 'null' (#300)", () => {
    const conf = ccfddlConferenceOf({
      title: "TestConf",
      rank: { ccf: " A ", core: null, other: "", invalid: "null" },
    });
    expect(conf?.rank).toEqual({ ccf: "A" });
  });

  it("ccfddl conferenceOf falls back to raw.link and raw.full_name (#320)", () => {
    const conf1 = ccfddlConferenceOf({
      title: "TestConf",
      link: "https://example.com/main",
      full_name: "Test Conference Full Name",
      confs: [],
    });
    expect(conf1?.link).toBe("https://example.com/main");
    expect(conf1?.full_name).toBe("Test Conference Full Name");

    // When description is present, description wins
    const conf2 = ccfddlConferenceOf({
      title: "TestConf2",
      description: "Description Full Name",
      full_name: "Ignored Full Name",
    });
    expect(conf2?.full_name).toBe("Description Full Name");

    // When edition has link, edition link wins
    const conf3 = ccfddlConferenceOf({
      title: "TestConf3",
      link: "https://example.com/top",
      confs: [{ year: 2026, link: "https://example.com/2026" }],
    });
    expect(conf3?.link).toBe("https://example.com/2026");
  });

  it("parsePrimaryArgs handles null, undefined, and equals syntax safely (#324)", () => {
    expect(parsePrimaryArgs(null)).toEqual({
      apply: false,
      registryPath: expect.any(String),
      outPath: expect.any(String),
      help: false,
    });
    expect(parsePrimaryArgs(undefined)).toEqual({
      apply: false,
      registryPath: expect.any(String),
      outPath: expect.any(String),
      help: false,
    });

    const res1 = parsePrimaryArgs(["--apply=true", "-r=custom_reg.yaml", "-o=custom_out.yaml"]);
    expect(res1.apply).toBe(true);
    expect(res1.registryPath).toBe("custom_reg.yaml");
    expect(res1.outPath).toBe("custom_out.yaml");

    const res2 = parsePrimaryArgs(["--apply=false", "-a=0", "--help"]);
    expect(res2.apply).toBe(false);
    expect(res2.help).toBe(true);
  });

  it("cacheSlot and extractedRoot handle null and undefined safely (#326)", () => {
    expect(extractedRoot(null)).toBeNull();
    expect(extractedRoot(undefined)).toBeNull();
    expect(extractedRoot("")).toBeNull();
    expect(extractedRoot("/tmp/nonexistent-slot-12345")).toBeNull();

    expect(cacheSlot(null, "ccfddl/ccf-deadlines", "main")).toBe(
      ".cache/ccfddl__ccf-deadlines__main",
    );
    expect(cacheSlot(undefined, null, null)).toBe(".cache/__");
    expect(cacheSlot("/custom/cache", "user/repo", "feat/branch")).toBe(
      "/custom/cache/user__repo__feat__branch",
    );
  });

  it("aideadlines deadlinesOf, editionOf, and parseTree handle null and undefined safely (#328)", () => {
    expect(aideadlinesDeadlinesOf(null)).toEqual([]);
    expect(aideadlinesDeadlinesOf(undefined)).toEqual([]);
    expect(editionOf(null)).toBeNull();
    expect(editionOf(undefined)).toBeNull();
    expect(aideadlinesParseTree(null)).toEqual([]);
    expect(aideadlinesParseTree(undefined)).toEqual([]);
    expect(aideadlinesParseTree("/tmp/nonexistent-aideadlines-dir-12345")).toEqual([]);
  });

  it("local parseFile falls back to latest edition link when raw.link is missing (#330)", () => {
    const tmpPath = "/tmp/test-local-link-fallback-330.yaml";
    writeFileSync(
      tmpPath,
      `conferences:
  - title: FallbackConf
    key: fallback-conf
    editions:
      - year: 2025
        link: "https://example.com/2025"
      - year: 2026
        link: "https://example.com/2026"
  - title: ExplicitConf
    key: explicit-conf
    link: "https://example.com/top"
    editions:
      - year: 2026
        link: "https://example.com/2026-sub"
`,
      "utf8",
    );

    try {
      const confs = localParseFile(tmpPath);
      expect(confs).toHaveLength(2);
      expect(confs[0].link).toBe("https://example.com/2026");
      expect(confs[1].link).toBe("https://example.com/top");
    } finally {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    }
  });
});
