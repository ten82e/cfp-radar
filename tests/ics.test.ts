/**
 * ICS output requirements: SPEC.md section 4.1.
 * Ported from tests/test_ics.py.
 */

import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { load as loadYaml } from "js-yaml";
import { describe, expect, it } from "vitest";
import { buildAll, UID_DOMAIN } from "../src/build.ts";
import type { Conference } from "../src/model.ts";
import {
  icsPhysicalLines,
  makeConference,
  makeDeadline,
  makeEdition,
  NOW,
  REPO_ROOT,
  unfoldIcs,
  veventBlocks,
} from "./helpers.ts";

// Long enough that folding is unavoidable, and multi-byte throughout.
const JP_COMMENT =
  "投稿は査読付き本会議トラックのみで、テンプレート違反・書式逸脱・匿名化不備は机上却下となる。詳細は募集要項を参照のこと。";
const TRICKY_PLACE = "Denver, Colorado, USA; 会場は大規模会議場 \\ 別館";
const LINK = "https://conferences.sigcomm.org/sigcomm/2026/";

const PAPER_AT = new Date(Date.UTC(2026, 1, 7, 11, 59, 59)); // 2026-02-06 23:59:59 AoE

function conferences(): Conference[] {
  const sigcomm = makeConference({
    key: "sigcomm",
    title: "SIGCOMM",
    full_name: "ACM SIGCOMM Conference",
    link: LINK,
    rank: { ccf: "A", core: "A*" },
    upstream_sub: "NW",
    categories: ["networking"],
    sources: ["ccfddl"],
    editions: [
      makeEdition({
        year: 2026,
        edition_id: "sigcomm26",
        link: LINK,
        place: TRICKY_PLACE,
        date_text: "August 17 - 21, 2026",
        event_start: new Date(Date.UTC(2026, 7, 17)),
        event_end: new Date(Date.UTC(2026, 7, 21)),
        deadlines: [
          makeDeadline(
            "abstract",
            "Abstract registration",
            new Date(Date.UTC(2026, 0, 31, 11, 59, 59)),
            "AoE",
          ),
          makeDeadline("paper", "Paper submission", PAPER_AT, "AoE", 1, JP_COMMENT),
        ],
      }),
      makeEdition({
        year: 2027,
        edition_id: "sigcomm27",
        link: LINK,
        place: "TBD",
        date_text: "",
        estimated: true,
        deadlines: [
          makeDeadline(
            "paper",
            "Paper submission (estimated)",
            new Date(PAPER_AT.getTime() + 364 * 86_400_000),
            "AoE",
          ),
        ],
      }),
    ],
  });
  const sc = makeConference({
    key: "sc",
    title: "SC",
    full_name: "International Conference for High Performance Computing",
    link: "https://sc26.supercomputing.org/",
    rank: { ccf: "A", core: "A" },
    upstream_sub: "DS",
    categories: ["hpc"],
    sources: ["ccfddl"],
    editions: [
      makeEdition({
        year: 2026,
        edition_id: "sc26",
        link: "https://sc26.supercomputing.org/",
        place: "Chicago, Illinois, USA",
        date_text: "November 15-20, 2026",
        event_start: new Date(Date.UTC(2026, 10, 15)),
        event_end: new Date(Date.UTC(2026, 10, 20)),
        deadlines: [
          makeDeadline(
            "paper",
            "Paper submission",
            new Date(Date.UTC(2026, 3, 9, 11, 59, 0)),
            "AoE",
          ),
        ],
      }),
    ],
  });
  return [sigcomm, sc];
}

function realConfig(): Record<string, unknown> {
  return (
    (loadYaml(readFileSync(join(REPO_ROOT, "config.yaml"), "utf8")) as Record<string, unknown>) ??
    {}
  );
}

function buildTo(dir: string, confs: Conference[], config?: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  void buildAll(confs, config ?? realConfig(), dir, NOW);
}

function read(dir: string, name: string): Buffer {
  return readFileSync(join(dir, name));
}

function textOf(dir: string, name: string): string {
  return read(dir, name).toString("utf8");
}

function uidsOf(dir: string, name: string): Set<string> {
  const blocks = veventBlocks(unfoldIcs(textOf(dir, name)));
  const uids = new Set<string>();
  for (const block of blocks) {
    for (const line of block) {
      if (line.startsWith("UID:")) uids.add(line.slice(4));
    }
  }
  return uids;
}

function eventsOf(dir: string, name: string): Array<Record<string, string>> {
  const blocks = veventBlocks(unfoldIcs(textOf(dir, name)));
  return blocks.map((block) => {
    const ev: Record<string, string> = {};
    for (const line of block) {
      const idx = line.indexOf(":");
      if (idx > 0) ev[line.slice(0, idx)] = line.slice(idx + 1);
    }
    return ev;
  });
}

describe("ICS line structure", () => {
  const dir = "/tmp/ics-test-site";

  it("line endings are CRLF", () => {
    buildTo(dir, conferences());
    const raw = read(dir, "all.ics").toString("utf8");
    expect(raw.includes("\r\n")).toBe(true);
    expect(raw.replace(/\r\n/g, "").includes("\n")).toBe(false);
    expect(raw.replace(/\r\n/g, "").includes("\r")).toBe(false);
  });

  it("lines are folded at 75 octets", () => {
    const lines = icsPhysicalLines(read(dir, "all.ics"));
    expect(lines.length).toBeGreaterThan(0);
    const over = lines.filter((ln) => Buffer.byteLength(ln) > 75);
    expect(over).toEqual([]);
    const continuations = lines.filter((ln) => ln.startsWith(" ") || ln.startsWith("\t"));
    expect(continuations.length).toBeGreaterThan(0);
  });

  it("folding does not split UTF-8 characters", () => {
    for (const name of ["all.ics", "deadlines.ics", "networking.ics"]) {
      for (const [i, line] of icsPhysicalLines(read(dir, name)).entries()) {
        try {
          Buffer.from(line, "utf8").toString("utf8");
          new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(line, "utf8"));
        } catch {
          throw new Error(`${name} line ${i + 1} split a multi-byte character`);
        }
      }
    }
  });

  it("multibyte content survives a fold/unfold roundtrip", () => {
    const joined = unfoldIcs(textOf(dir, "all.ics")).join("\n");
    expect(joined.includes(JP_COMMENT)).toBe(true);
  });
});

describe("ICS escaping", () => {
  const dir = "/tmp/ics-test-site";

  it("colon is not escaped", () => {
    const lines = unfoldIcs(textOf(dir, "all.ics"));
    const joined = lines.join("\n");
    expect(joined.includes("\\:")).toBe(false);
    const urls = lines.filter((ln) => ln.startsWith("URL:"));
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.some((ln) => ln.startsWith("URL:https://"))).toBe(true);
  });

  it("comma semicolon and backslash are escaped", () => {
    const lines = unfoldIcs(textOf(dir, "all.ics"));
    const descriptions = lines
      .filter((ln) => ln.startsWith("DESCRIPTION:"))
      .map((ln) => ln.slice("DESCRIPTION:".length));
    const target = descriptions.filter((d) => d.includes("Colorado"));
    expect(target.length).toBeGreaterThan(0);
    const value = target[0];
    expect(value.includes("\\,")).toBe(true);
    expect(value.includes("\\;")).toBe(true);
    expect(value.includes("\\\\")).toBe(true);
    expect(/(?<!\\)[,;]/.test(value)).toBe(false);
  });

  it("no literal newline inside text values", () => {
    for (const line of unfoldIcs(textOf(dir, "all.ics"))) {
      expect(line.includes("\n")).toBe(false);
      expect(line.includes("\r")).toBe(false);
    }
  });
});

describe("calendar level properties", () => {
  const dir = "/tmp/ics-test-site";

  it("calendar properties", () => {
    const lines = unfoldIcs(textOf(dir, "all.ics"));
    expect(lines[0]).toBe("BEGIN:VCALENDAR");
    expect(["END:VCALENDAR", ""]).toContain(lines[lines.length - 1]);
    expect(lines).toContain("VERSION:2.0");
    expect(lines).toContain("CALSCALE:GREGORIAN");
    expect(lines).toContain("X-WR-TIMEZONE:UTC");
    expect(lines).toContain("REFRESH-INTERVAL;VALUE=DURATION:PT12H");
    expect(lines).toContain("X-PUBLISHED-TTL:PT12H");
    expect(lines).toContain("PRODID:-//conf-deadlines//conf-deadlines//EN");
  });

  it("METHOD is not emitted", () => {
    for (const name of ["all.ics", "deadlines.ics", "all-estimated.ics"]) {
      const lines = unfoldIcs(textOf(dir, name));
      expect(lines.some((ln) => ln.startsWith("METHOD"))).toBe(false);
      expect(lines.some((ln) => ln.startsWith("SEQUENCE"))).toBe(false);
    }
    const lines = unfoldIcs(textOf(dir, "all.ics"));
    expect(lines.some((ln) => ln.startsWith("X-WR-CALNAME"))).toBe(true);
    expect(lines.some((ln) => ln.startsWith("X-WR-CALDESC"))).toBe(true);
  });
});

describe("events", () => {
  const dir = "/tmp/ics-test-site";

  it("deadline event shape", () => {
    const events = eventsOf(dir, "deadlines.ics");
    const target = events.filter((e) => e.UID === "sigcomm-2026-paper-1@conf-deadlines.github.io");
    expect(target.length).toBeGreaterThan(0);
    const ev = target[0];
    expect(ev.DTEND).toBe("20260207T115959Z");
    expect(ev.DTSTART).toBe("20260207T112959Z");
    expect(ev.SUMMARY).toContain("SIGCOMM");
    expect(ev.SUMMARY).toContain("2026");
    expect(ev.URL).toBe(LINK);
    // 対象イベントのブロック内の VALARM が 3 つ（-P7D / -P1D / -PT3H）
    const block = veventBlocks(unfoldIcs(textOf(dir, "deadlines.ics"))).find((b) =>
      b.some((l) => l.startsWith("UID:sigcomm-2026-paper-1@")),
    );
    const triggers = block
      ?.filter((ln) => ln.startsWith("TRIGGER:"))
      .map((ln) => ln.slice("TRIGGER:".length));
    expect(triggers).toEqual(["-P7D", "-P1D", "-PT3H"]);
  });

  it("all day event DTEND is end plus one day", () => {
    const events = eventsOf(dir, "all.ics");
    const target = events.filter((e) => e.UID === "sigcomm-2026-event@conf-deadlines.github.io");
    expect(target.length).toBeGreaterThan(0);
    const ev = target[0];
    expect(ev["DTSTART;VALUE=DATE"] ?? ev.DTSTART).toBe("20260817");
    const dtend = ev["DTEND;VALUE=DATE"] ?? ev.DTEND;
    expect(dtend).toBe("20260822");
    const block = veventBlocks(unfoldIcs(textOf(dir, "all.ics"))).find((b) =>
      b.some((l) => l.startsWith("UID:sigcomm-2026-event@")),
    );
    expect(block?.some((l) => l.startsWith("TRIGGER:"))).toBe(false);
  });

  it("all day events use VALUE=DATE", () => {
    const lines = unfoldIcs(textOf(dir, "all.ics"));
    const starts = lines.filter((ln) => ln.startsWith("DTSTART"));
    const eventStarts = starts.filter((ln) => ln.includes("VALUE=DATE"));
    expect(eventStarts.length).toBeGreaterThan(0);
    for (const ln of eventStarts) {
      expect(/:\d{8}$/.test(ln)).toBe(true);
    }
  });

  it("deadline timestamps are UTC Z form", () => {
    const lines = unfoldIcs(textOf(dir, "deadlines.ics"));
    for (const ln of lines) {
      if (ln.startsWith("DTSTART:") || ln.startsWith("DTEND:")) {
        expect(/^DT(START|END):\d{8}T\d{6}Z$/.test(ln)).toBe(true);
      }
    }
  });
});

describe("feed partitioning", () => {
  const dir = "/tmp/ics-test-site";

  it("estimated editions are only in the estimated feed", () => {
    const estimated = uidsOf(dir, "all-estimated.ics");
    expect([...estimated].some((u) => u.startsWith("sigcomm-2027-"))).toBe(true);
    for (const name of ["all.ics", "deadlines.ics", "networking.ics"]) {
      const uids = uidsOf(dir, name);
      expect([...uids].some((u) => u.startsWith("sigcomm-2027-"))).toBe(false);
    }
  });

  it("category feeds are subsets of all", () => {
    const everything = uidsOf(dir, "all.ics");
    for (const name of ["networking.ics", "hpc.ics", "deadlines.ics"]) {
      const uids = uidsOf(dir, name);
      for (const u of uids) {
        expect(everything.has(u)).toBe(true);
      }
    }
  });

  it("category feeds are disjoint", () => {
    const net = uidsOf(dir, "networking.ics");
    const hpc = uidsOf(dir, "hpc.ics");
    for (const u of net) {
      expect(hpc.has(u)).toBe(false);
    }
    expect([...net].some((u) => u.startsWith("sigcomm-2026-"))).toBe(true);
    expect([...hpc].some((u) => u.startsWith("sc-2026-"))).toBe(true);
  });

  it("deadline feed has no event rows", () => {
    for (const u of uidsOf(dir, "deadlines.ics")) {
      expect(u.includes("-event@")).toBe(false);
    }
  });
});

describe("UID stability", () => {
  const dir = "/tmp/ics-test-site";

  it("uids are stable and unique", () => {
    const uids = [...uidsOf(dir, "all.ics")];
    expect(new Set(uids).size).toBe(uids.length);
    for (const uid of uids) {
      expect(/^[^@\s]+@[^@\s]+$/.test(uid)).toBe(true);
    }
    expect(uids).toContain("sigcomm-2026-paper-1@conf-deadlines.github.io");
    expect(uids).toContain("sigcomm-2026-event@conf-deadlines.github.io");
  });

  const UID_RE =
    /^[a-z0-9][a-z0-9-]*-(19|20)\d\d-(abstract|paper|supplementary|notification|camera_ready|rebuttal_start|rebuttal_end|review_release|registration|other|event)(-\d+)?@conf-deadlines\.github\.io$/;

  it("uids follow the spec shape", () => {
    for (const name of ["all.ics", "all-estimated.ics"]) {
      const uids = [...uidsOf(dir, name)];
      expect(uids.length).toBeGreaterThan(0);
      const bad = uids.filter((u) => !UID_RE.test(u));
      expect(bad).toEqual([]);
      expect(uids.some((u) => u.startsWith("sigcomm26"))).toBe(false);
    }
  });

  it("uid domain is frozen and independent of config", () => {
    const seen: string[][] = [];
    for (const domain of ["conf-deadlines.github.io", "somebody-else.example.com"]) {
      const config = realConfig();
      const site = (config.site as Record<string, unknown>) ?? {};
      site.domain = domain;
      site.base_url = `https://${domain}/x`;
      config.site = site;
      const outdir = `/tmp/ics-test-${domain}`;
      buildTo(outdir, conferences(), config);
      seen.push([...uidsOf(outdir, "all.ics")].sort());
    }
    expect(seen[0]).toEqual(seen[1]);
    expect(seen[0].every((u) => u.endsWith(`@${UID_DOMAIN}`))).toBe(true);
  });

  it("uid ordinal follows deadline time not the upstream array order", () => {
    const early = new Date(Date.UTC(2026, 0, 10, 12, 0, 0));
    const late = new Date(Date.UTC(2026, 5, 10, 12, 0, 0));

    const build = (first: Date, second: Date): Record<string, string> => {
      const conf = makeConference({
        key: "nsdi",
        title: "NSDI",
        categories: ["networking"],
        editions: [
          makeEdition({
            year: 2026,
            edition_id: "nsdi26",
            deadlines: [
              makeDeadline("paper", "r1", first, "AoE", 1),
              makeDeadline("paper", "r2", second, "AoE", 2),
            ],
          }),
        ],
      });
      const outdir = `/tmp/ics-ord-${first.getTime()}`;
      buildTo(outdir, [conf]);
      const events = eventsOf(outdir, "all.ics");
      return Object.fromEntries(events.map((e) => [e.UID, e.DTEND]));
    };

    const ascending = build(early, late);
    const reordered = build(late, early);
    expect(ascending).toEqual(reordered);
    expect(ascending["nsdi-2026-paper-1@conf-deadlines.github.io"]).toBe("20260110T120000Z");
    expect(ascending["nsdi-2026-paper-2@conf-deadlines.github.io"]).toBe("20260610T120000Z");
  });

  it("URL property is not text escaped", () => {
    const link = "https://example.org/cfp?a=1,2;b=3";
    const conf = makeConference({
      key: "sigcomm",
      title: "SIGCOMM",
      link,
      categories: ["networking"],
      editions: [
        makeEdition({
          year: 2026,
          edition_id: "sigcomm26",
          link,
          deadlines: [makeDeadline("paper", "p", PAPER_AT, "AoE")],
        }),
      ],
    });
    const outdir = "/tmp/ics-uri";
    buildTo(outdir, [conf]);
    const urls = unfoldIcs(textOf(outdir, "all.ics"))
      .filter((ln) => ln.startsWith("URL:"))
      .map((ln) => ln.slice(4));
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u === link)).toBe(true);
  });

  it("DTSTAMP is derived from now not wall clock", () => {
    const events = eventsOf(dir, "all.ics");
    const stamps = new Set(events.map((e) => e.DTSTAMP));
    expect(stamps.size).toBe(1);
    const stamp = [...stamps][0];
    expect(stamp).toBe("20260809T000000Z");
  });

  it("LAST-MODIFIED is absent", () => {
    expect(textOf(dir, "all.ics").includes("LAST-MODIFIED")).toBe(false);
  });
});

describe("determinism", () => {
  it("two builds with the same now are byte identical", () => {
    const first = "/tmp/ics-det-a";
    const second = "/tmp/ics-det-b";
    buildTo(first, conferences());
    buildTo(second, conferences());
    const names = ["all.ics", "deadlines.ics", "networking.ics", "hpc.ics"];
    for (const name of names) {
      expect(read(first, name)).toEqual(read(second, name));
    }
  });
});
