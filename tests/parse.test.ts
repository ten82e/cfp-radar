/**
 * parse_instant / parse_date_range / slug: SPEC.md section 3.
 * Ported from tests/test_parse.py.
 */

import { describe, expect, it } from "vitest";
import {
  parseDateRange,
  parseInstant,
  resetWarnings,
  slug,
  warn,
  warningCounts,
} from "../src/model.ts";
import { editionOf } from "../src/sources/aideadlines.ts";
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

  it.each(["TBD", "tbd", "", "   ", "N/A", "to be announced"])(
    "unparseable %j returns null",
    (text) => {
      expect(parseInstant(text, "AoE")).toBeNull();
    },
  );

  it("unparseable does not raise for missing timezone", () => {
    expect(parseInstant("TBD", null)).toBeNull();
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
