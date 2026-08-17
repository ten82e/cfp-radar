/**
 * discover.ts / review-candidates.ts のテスト。
 * Ported from tests/test_discover.py.
 */

import { describe, expect, it } from "vitest";
import {
  cleanDbworldTitle,
  deadlineIsFuture,
  easyChairEntriesFromRows,
  extractDeadlinesFromText,
  formatDiscoveredYaml,
  inDomain,
  makeCandidate,
  NicheDiscoverer,
  parseComsocCfpHtml,
  parseDbworldHtml,
  parseDeadlineText,
  parseEasyChairCfpHtml,
  parseIeiceCfpHtml,
  parseIpsjCfpHtml,
  parseWikiCfpHtml,
  toYamlDict,
} from "../src/discover.ts";
import {
  isPredatory,
  loadTrackedTitles,
  normTitle,
  parseArgs as parseReviewArgs,
  reviewDeadlineText,
  runReviewCandidates,
  tagSource,
} from "../src/review-candidates.ts";
import { REPO_ROOT } from "./helpers.ts";

const utcDate = (y: number, m: number, d: number): Date => new Date(Date.UTC(y, m - 1, d));

describe("NicheDiscoverer", () => {
  const discoverer = new NicheDiscoverer(REPO_ROOT);

  it("initialization tracks known keys", () => {
    expect(discoverer.knownKeys.size).toBeGreaterThan(0);
    expect(discoverer.knownKeys.has("sigcomm") || discoverer.knownKeys.has("isc-hpc")).toBe(true);
  });

  it("already tracked check", () => {
    expect(discoverer.isAlreadyTracked("sigcomm")).toBe(true);
    expect(discoverer.isAlreadyTracked("isc-hpc")).toBe(true);
    expect(discoverer.isAlreadyTracked("completely-unknown-fake-niche-venue-999")).toBe(false);
  });

  it("classify category across taxonomy domains", () => {
    const hpc = discoverer.classifyCategory(
      "International Workshop on High Performance Computing Interconnects",
    );
    expect(hpc).toContain("hpc");
    const sec = discoverer.classifyCategory(
      "IEEE Workshop on System Security and Confidential Computing",
    );
    expect(sec.includes("security") || sec.includes("systems")).toBe(true);

    const dbTheory = discoverer.classifyCategory("International Conference on Database Theory");
    expect(dbTheory).toContain("db");
    expect(dbTheory).toContain("theory");

    const ai = discoverer.classifyCategory("Machine Learning and Computer Vision");
    expect(ai).toContain("ai");

    const hci = discoverer.classifyCategory(
      "ACM Conference on Human Factors in Computing Systems and User Interface",
    );
    expect(hci).toContain("hci");

    const graphics = discoverer.classifyCategory("IEEE Visualization and Virtual Reality");
    expect(graphics).toContain("graphics");
  });

  it("run discovery returns candidates with required fields", async () => {
    const cands = await discoverer.runDiscovery(["systems"], 2026);
    for (const c of cands) {
      expect(c.key).toBeTruthy();
      expect(c.title).toBeTruthy();
      expect(c.link).toBeTruthy();
    }
  }, 120_000);
  it("discoverFromDblp decodes HTML entities and trims leading whitespace", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          result: {
            hits: {
              hit: [
                {
                  // DBLP venue API は先頭空白付きで &quot; / &apos; を含む名前を返す。
                  info: {
                    venue: " &quot;Fake&apos;s &amp; Foes&quot; Workshop Series (FAKEWS)",
                    acronym: "FAKEWS",
                    url: "https://dblp.org/db/conf/fakews/",
                  },
                },
                {
                  // acronym 無し (journal) は venue 名が title/key にそのまま入る。
                  info: {
                    venue: "Synthetic Journal of Computer &amp; Information Science",
                    url: "https://dblp.org/db/journals/synthj/",
                  },
                },
              ],
            },
          },
        }),
        { status: 200 },
      )) as typeof fetch;
    try {
      // 共有インスタンスは直前の live 実行 (run discovery) で knownKeys が
      // 実 DBLP データで汚染され得るため、分離インスタンスで検証する。
      const isolated = new NicheDiscoverer(REPO_ROOT);
      const cands = await isolated.discoverFromDblp("workshop", 10);

      const fakews = cands.find((c) => c.key === "fakews");
      expect(fakews).toBeDefined();
      expect(fakews?.full_name).toBe('"Fake\'s & Foes" Workshop Series (FAKEWS)');
      expect(fakews?.full_name?.startsWith(" ")).toBe(false);
      expect(fakews?.title).toBe("FAKEWS");

      const journal = cands.find((c) => c.key.startsWith("synthetic-journal"));
      expect(journal).toBeDefined();
      expect(journal?.title).toBe("Synthetic Journal of Computer & Information Science");
      expect(journal?.key).toBe("synthetic-journal-of-computer-information-science");
      expect(journal?.key).not.toContain("amp");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("formatDiscoveredYaml", () => {
  it("serializes a candidate", () => {
    const cand = makeCandidate({
      key: "nvmw",
      title: "NVMW",
      full_name: "Non-Volatile Memories Workshop",
      link: "https://nvmw.ucsd.edu/",
      categories: ["systems"],
      tags: ["niche", "workshop"],
      place: "San Diego, CA, USA",
      date_text: "March 8-10, 2026",
    });
    const text = formatDiscoveredYaml([cand]);
    expect(text).toContain("key: nvmw");
    expect(text).toContain("title: NVMW");
    expect(text).toContain("Non-Volatile Memories Workshop");
  });
});

describe("extractDeadlinesFromText", () => {
  it("extracts paper and notification", () => {
    const deadlines = extractDeadlinesFromText(
      "Paper submission is due by 2026-05-15 and notification date is 2026-07-20.",
    );
    expect(deadlines.length).toBe(2);
    expect(deadlines[0].kind).toBe("paper");
    expect(deadlines[0].date).toBe("2026-05-15 23:59:00");
    expect(deadlines[1].kind).toBe("notification");
    expect(deadlines[1].date).toBe("2026-07-20 23:59:00");
  });

  it("extracts year 2030+ and slash/dot formatted dates", () => {
    const deadlines = extractDeadlinesFromText(
      "Paper due 2030/01/15 and notification on 2030.03.20",
    );
    expect(deadlines.length).toBe(2);
    expect(deadlines[0].date).toBe("2030-01-15 23:59:00");
    expect(deadlines[1].date).toBe("2030-03-20 23:59:00");
  });

  it("normalizes single-digit month and day", () => {
    const deadlines = extractDeadlinesFromText("Submission: 2026/5/9, Notification: 2026-7-1");
    expect(deadlines.length).toBe(2);
    expect(deadlines[0].date).toBe("2026-05-09 23:59:00");
    expect(deadlines[1].date).toBe("2026-07-01 23:59:00");
  });

  it("discards invalid calendar dates", () => {
    expect(extractDeadlinesFromText("Due: 2026-02-30")).toEqual([]);
    expect(extractDeadlinesFromText("Due: 2026-04-31 and 2026-09-31")).toEqual([]);
  });
});

describe("parseDbworldHtml", () => {
  const HTML = `<TABLE><TBODY>
<TR VALIGN=TOP><TD>Sun, 9 Aug 2026 18:22:00 +0000</TD><TD>X</TD>
<TD><A HREF=https://listserv.acm.org/SCRIPTS/WA-ACMLPX.CGI?A2=MOD-DBWORLD;ff70>INDIS 2026: Paper Submission Deadline Extended to August 3</A></TD></TR>
<TR VALIGN=TOP><TD>Mon, 10 Aug 2026 09:00:00 +0000</TD><TD>Y</TD>
<TD><A HREF=https://listserv.acm.org/x>PDP 2027  Call for Papers &amp; Call for Special Sessions</A></TD></TR>
<TR VALIGN=TOP><TD>Mon, 10 Aug 2026 09:10:00 +0000</TD><TD>Z</TD>
<TD><A HREF=https://listserv.acm.org/y>Some random announcement</A></TD></TR>
<TR VALIGN=TOP><TD>Mon, 10 Aug 2026 09:20:00 +0000</TD><TD>W</TD>
<TD><A HREF=https://listserv.acm.org/z>[DEADLINE EXTENDED] AI4DEMONS 2026@CIKM2026</A></TD></TR>
</TBODY></TABLE>`;

  it("parses rows", () => {
    const items = parseDbworldHtml(HTML);
    expect(items.length).toBe(3); // CFP/DEADLINE 関連のみ
    expect(items[0].subject).toBe("INDIS 2026: Paper Submission Deadline Extended to August 3");
    expect(items[1].subject).toBe("PDP 2027  Call for Papers & Call for Special Sessions");
  });

  it("cleans titles", () => {
    expect(cleanDbworldTitle("INDIS 2026: Paper Submission Deadline Extended to August 3")[0]).toBe(
      "INDIS 2026",
    );
    expect(cleanDbworldTitle("PDP 2027  Call for Papers & Call for Special Sessions")[0]).toBe(
      "PDP 2027",
    );
    expect(cleanDbworldTitle("[DEADLINE EXTENDED] AI4DEMONS 2026@CIKM2026")[0]).toBe(
      "AI4DEMONS 2026@CIKM2026",
    );
    expect(
      cleanDbworldTitle("iiWAS 2026 || Submission Deadline: 1 August 2026 (Final) || Bangkok")[0],
    ).toBe("iiWAS 2026");
    expect(
      cleanDbworldTitle("Call for Papers: ACM SIGSPATIAL 2026 Workshops & Competitions")[0],
    ).toBe("ACM SIGSPATIAL 2026 Workshops & Competitions");
    expect(
      cleanDbworldTitle(
        "[Reminder] ACM TWEB Special Issue on the Agentic Web (Deadline: Sept. 30, 2026)",
      )[1],
    ).toBe("journal");
    // 残課題ケース (2026-08-10 実データから)
    expect(cleanDbworldTitle("Last CFP: SIMBig 2026 | NAACL Awards | Deadline (Aug 7)")[0]).toBe(
      "SIMBig 2026",
    );
    expect(
      cleanDbworldTitle("Deadline extended: ER 2026 Call for Doctoral Symposium Papers")[0],
    ).toBe("ER 2026");
    expect(
      cleanDbworldTitle(
        "Extended Submission Deadline  DTSSB 2026 Workshop @ BIR 2026 (August 16)",
      )[0].startsWith("DTSSB 2026"),
    ).toBe(true);
    expect(
      cleanDbworldTitle(
        "DEADLINE EXTENSION ICAIF 2026  ACM International Conference on AI in Finance",
      )[0],
    ).toBe("ICAIF 2026 ACM International Conference on AI in Finance");
    expect(
      cleanDbworldTitle(
        "CfP Special Issue on Lakehouse Systems in GI Datenbankspektrum",
      )[0].startsWith("Special Issue"),
    ).toBe(true);
    expect(cleanDbworldTitle("– CRiSIS 2026 (Rabat, Morocco) – Extended deadline")[0]).toBe(
      "CRiSIS 2026 (Rabat, Morocco)",
    );
    expect(
      cleanDbworldTitle(
        "[DEADLINE APPROACHING][CWN'26] Thirteenth International Workshop on Cooperative Wireless Networks",
      )[0],
    ).toBe("Thirteenth International Workshop on Cooperative Wireless Networks");
  });
});

describe("parseEasyChairCfpHtml", () => {
  it("parses rows", () => {
    const html = `<tbody>
<tr class="green"><td><a href="/cfp/medchiconnect2026" onclick="return EC.linkClick(event)">MedCHI_Connect 2026</a></td><td>Connecting Mediterranean Research and Communities</td><td>Fisciano (SA), Italy</td><td>Oct 12, 2026</td><td></td><td><span class="tag fg_bluelight bg_seagreenlight">network</span></td></tr>
<tr><td><a href="/cfp/irret2027">IRRET-2027</a></td><td>7th Int. Conf. on Renewable Energy Technologies</td><td>Malda, India</td><td>Dec 10, 2026</td><td>Feb 21, 2027</td><td></td></tr>
</tbody>`;
    const items = parseEasyChairCfpHtml(html);
    expect(items.length).toBe(2);
    expect(items[0].title).toBe("MedCHI_Connect 2026");
    expect(items[0].date_text).toBe("Oct 12, 2026");
    expect(items[0].place).toBe("Fisciano (SA), Italy");
    expect(items[0].topics).toEqual(["network"]);
    expect(items[0].url).toBe("https://easychair.org/cfp/medchiconnect2026");
    expect(items[1].start).toBe("Feb 21, 2027");
  });
});

describe("EasyChair event date vs submission deadline", () => {
  it("serializes the event date as edition date_text and keeps the deadline for review", () => {
    const html = `<tbody>
<tr><td><a href="/cfp/iceta2026">ICETA 2026</a></td><td>Int. Conf. on Secure Network Systems</td><td>Slovakia</td><td>Aug 16, 2026</td><td>Nov 9-11, 2026</td><td></td></tr>
</tbody>`;
    const rows = parseEasyChairCfpHtml(html);
    expect(rows.length).toBe(1);
    expect(rows[0].date_text).toBe("Aug 16, 2026"); // 4 列目: 提出締切
    expect(rows[0].start).toBe("Nov 9-11, 2026"); // 5 列目: 開催日
    const entries = easyChairEntriesFromRows(rows, 2026);
    expect(entries.length).toBe(1);
    expect(entries[0].date_text).toBe("Nov 9-11, 2026");
    expect(entries[0].submission_deadline_text).toBe("Aug 16, 2026");

    const cand = makeCandidate({
      key: String(entries[0].key),
      title: String(entries[0].title),
      full_name: String(entries[0].full_name),
      link: String(entries[0].link),
      categories: entries[0].categories as string[],
      tags: ["niche", "easychair"],
      source_type: String(entries[0].source_type),
      date_text: String(entries[0].date_text),
      submission_deadline_text: String(entries[0].submission_deadline_text),
      place: String(entries[0].place),
    });
    const dict = toYamlDict(cand);
    const editions = dict.editions as Array<Record<string, unknown>>;
    expect(editions[0].date_text).toBe("Nov 9-11, 2026");
    expect(dict.submission_deadline_text).toBe("Aug 16, 2026");
    // 日付のみの値を構造化 deadline にでっち上げない
    expect(editions[0].deadlines).toEqual([]);
    // レビュー締切順は保持した提出締切を使う (開催日ではない)
    expect(parseDeadlineText(reviewDeadlineText(cand as Record<string, any>))).toEqual(
      utcDate(2026, 8, 16),
    );
    const text = formatDiscoveredYaml([cand]);
    expect(text).toContain("Nov 9-11, 2026");
    expect(text).toContain("Aug 16, 2026");
  });

  it("keeps next-year conferences whose fall deadline falls in the previous year (#261)", () => {
    // DASFAA 2026 の実締切 Oct 27, 2025 — タイトル年 (2026) が締切年 (2025) より優先されるべき
    const html = `<tbody>
<tr><td><a href="/cfp/dasfaa2026">DASFAA 2026</a></td><td>Int. Conf. on Database Systems for Advanced Applications</td><td>China</td><td>Oct 27, 2025</td><td>May 2026</td><td></td></tr>
</tbody>`;
    const entries = easyChairEntriesFromRows(parseEasyChairCfpHtml(html), 2026);
    expect(entries.length).toBe(1);
    expect(entries[0].key).toBe("dasfaa-2026");
    expect(entries[0].year).toBe(2026);
    expect(entries[0].submission_deadline_text).toBe("Oct 27, 2025");
  });

  it("falls back to the deadline year when the title has no year (#261)", () => {
    const html = `<tbody>
<tr><td><a href="/cfp/x2026">Workshop on Data Systems</a></td><td>Int. Workshop on Data Systems</td><td>Japan</td><td>Mar 10, 2026</td><td>Aug 2026</td><td></td></tr>
</tbody>`;
    const entries = easyChairEntriesFromRows(parseEasyChairCfpHtml(html), 2026);
    expect(entries.length).toBe(1);
    expect(entries[0].year).toBe(2026);
  });

  it("still drops candidates whose title and deadline years are below minYear (#261)", () => {
    const html = `<tbody>
<tr><td><a href="/cfp/old2024">OldConf 2024</a></td><td>Int. Conf. on Old Systems</td><td>US</td><td>Dec 15, 2023</td><td>May 2024</td><td></td></tr>
</tbody>`;
    const entries = easyChairEntriesFromRows(parseEasyChairCfpHtml(html), 2026);
    expect(entries.length).toBe(0);
  });

  it("blank event-date cell stays a valid candidate ordered by the deadline", () => {
    const html = `<tbody>
<tr><td><a href="/cfp/nodate2026">NoDate 2026</a></td><td>Workshop on Secure Networks</td><td>Tokyo, Japan</td><td>Dec 10, 2026</td><td></td><td></td></tr>
</tbody>`;
    const entries = easyChairEntriesFromRows(parseEasyChairCfpHtml(html), 2026);
    expect(entries.length).toBe(1);
    expect(entries[0].date_text).toBe("Dec 10, 2026");
    expect(entries[0].submission_deadline_text).toBe("Dec 10, 2026");
    const cand = makeCandidate({
      key: String(entries[0].key),
      title: String(entries[0].title),
      full_name: String(entries[0].full_name),
      link: String(entries[0].link),
      categories: entries[0].categories as string[],
      tags: ["niche", "easychair"],
      source_type: String(entries[0].source_type),
      date_text: String(entries[0].date_text),
      submission_deadline_text: String(entries[0].submission_deadline_text),
      place: String(entries[0].place),
    });
    expect(parseDeadlineText(reviewDeadlineText(cand as Record<string, any>))).toEqual(
      utcDate(2026, 12, 10),
    );
  });

  it("non-EasyChair serialization is unchanged", () => {
    const cand = makeCandidate({
      key: "nvmw",
      title: "NVMW",
      full_name: "Non-Volatile Memories Workshop",
      link: "https://nvmw.ucsd.edu/",
      categories: ["systems"],
      date_text: "March 8-10, 2026",
    });
    const dict = toYamlDict(cand);
    expect("submission_deadline_text" in dict).toBe(false);
    expect((dict.editions as Array<Record<string, unknown>>)[0].date_text).toBe("March 8-10, 2026");
    const text = formatDiscoveredYaml([cand]);
    expect(text).toContain("date_text: March 8-10, 2026");
    expect(text).not.toContain("submission_deadline_text");
  });
});

describe("inDomain", () => {
  it("classifies domain relevance", () => {
    expect(inDomain("IEEE AIoT 2026")).toBe(true);
    expect(inDomain("PARMA-DITAM 2027 Workshop on Parallel Programming")).toBe(true);
    expect(inDomain("Cyber Science 2027 London")).toBe(true);
    expect(inDomain("ML4CPS 2027 Machine Learning for Cyber-Physical Systems")).toBe(true);
    expect(inDomain("ICBBS 2026 Bioinformatics")).toBe(false);
    expect(inDomain("SOCTHADICKconf'26 Ibadan")).toBe(false);
  });
});

describe("parseDeadlineText", () => {
  it("parses various formats", () => {
    expect(parseDeadlineText("Aug 21, 2026")).toEqual(utcDate(2026, 8, 21));
    expect(parseDeadlineText("Nov 16, 2026 (Oct 1, 2026)")).toEqual(utcDate(2026, 11, 16));
    expect(parseDeadlineText("31 December 2026")).toEqual(utcDate(2026, 12, 31)); // 特集号形式
    expect(parseDeadlineText("2026-11-12")).toEqual(utcDate(2026, 11, 12)); // IEICE journals.php
    expect(parseDeadlineText("2026年12月4日（金）")).toEqual(utcDate(2026, 12, 4)); // IPSJ 特集論文募集
    expect(parseDeadlineText("1 October 2026")).toEqual(utcDate(2026, 10, 1));
    expect(parseDeadlineText("15.08.2026")).toEqual(utcDate(2026, 8, 15)); // DD.MM.YYYY
    expect(parseDeadlineText("31/12/2026")).toEqual(utcDate(2026, 12, 31)); // DD/MM/YYYY
    expect(parseDeadlineText("15-05-2026")).toEqual(utcDate(2026, 5, 15)); // DD-MM-YYYY
    expect(parseDeadlineText("November, 2026")).toBeNull(); // 月のみはでっち上げない
    expect(parseDeadlineText("unknown")).toBeNull();
  });

  it("keeps valid leap-year and year-omitted dates", () => {
    expect(parseDeadlineText("Feb 29, 2028")).toEqual(utcDate(2028, 2, 29)); // うるう年
    expect(parseDeadlineText("29 February 2028")).toEqual(utcDate(2028, 2, 29));
    const year = new Date().getUTCFullYear();
    expect(parseDeadlineText("Dec 5")).toEqual(utcDate(year, 12, 5)); // 年省略は当年
  });

  it("rejects impossible calendar dates instead of rolling them over", () => {
    // ISO 形式
    expect(parseDeadlineText("2026-02-30")).toBeNull(); // 2月30日
    expect(parseDeadlineText("2025-02-29")).toBeNull(); // 平年の2月29日
    expect(parseDeadlineText("2026-04-31")).toBeNull(); // 4月31日
    // 日本語形式
    expect(parseDeadlineText("2026年2月30日")).toBeNull();
    expect(parseDeadlineText("2025年2月29日")).toBeNull();
    // 日-月形式
    expect(parseDeadlineText("30 February 2026")).toBeNull();
    expect(parseDeadlineText("31 April 2026")).toBeNull();
    // 月-日形式
    expect(parseDeadlineText("Feb 30, 2026")).toBeNull();
    expect(parseDeadlineText("Feb 29, 2025")).toBeNull();
    expect(parseDeadlineText("April 31, 2026")).toBeNull();
    // 範囲外の月・日
    expect(parseDeadlineText("2026-00-15")).toBeNull();
    expect(parseDeadlineText("2026-13-01")).toBeNull();
    expect(parseDeadlineText("2026-01-00")).toBeNull();
    expect(parseDeadlineText("2026-01-32")).toBeNull();
  });
});

describe("parseComsocCfpHtml", () => {
  it("extracts manuscript deadlines", () => {
    const html =
      "<table><tr><th>Paper Topic</th><th>Publication Date</th>" +
      "<th>Manuscript Submission Deadline</th></tr>" +
      "<tr><td>AI Networks</td><td>September 2027</td><td>31 December 2026</td></tr>" +
      "<tr><td>Paper Topic</td><td>Publication Date</td><td>Manuscript Submission Deadline</td></tr>" +
      "<tr><td>Old Topic</td><td>2024</td><td>Closed</td></tr>" +
      "</table>";
    const es = parseComsocCfpHtml(html, "IEEE Network", "https://example.com/cfp");
    expect(es.length).toBe(1);
    expect(es[0].title).toContain("AI Networks");
    expect(es[0].title).toContain("IEEE Network");
    expect(es[0].date_text).toBe("31 December 2026");
    expect(es[0].source_type).toBe("special_issue");
    expect(es[0].link).toBe("https://example.com/cfp");
  });

  it("decodes HTML entities in the topic (title / full_name / key)", () => {
    const html =
      "<table><tr><th>Paper Topic</th><th>Publication Date</th>" +
      "<th>Manuscript Submission Deadline</th></tr>" +
      "<tr><td>AI &amp; Networking for 6G</td><td>September 2027</td><td>31 December 2026</td></tr>" +
      "</table>";
    const es = parseComsocCfpHtml(html, "IEEE Network", "https://example.com/cfp");
    expect(es.length).toBe(1);
    expect(es[0].title).toBe("AI & Networking for 6G（IEEE Network 特集号）");
    expect(es[0].full_name).toBe("AI & Networking for 6G（IEEE Network 特集号）");
    expect(es[0].key).toBe("ai-networking-for-6g-ieee-network"); // slug に amp が混入しない
  });
});

describe("parseIeiceCfpHtml", () => {
  it("extracts special sections", () => {
    const html =
      "<table><tr><th>Journal name</th><th>Deadline</th><th>Special section/issue</th><th>Issue</th></tr>" +
      "<tr><td>IEICE Trans. Inf. &amp; Syst.</td><td>2026-11-12</td>" +
      "<td>Special Section on Log Data Usage Technology</td><td>2027-12</td></tr>" +
      "<tr><td>NOLTA</td><td>2027-01-10</td><td>Special Section on Recent Progress</td><td>2027-07</td></tr>" +
      "<tr><td>IEICE Trans. Electron.</td><td>2024-03-01</td><td>Closed Section</td><td>2025-01</td></tr>" +
      "</table>";
    const es = parseIeiceCfpHtml(
      html,
      "https://www.ieice.org/eng_r/information/schedule/journals.php",
    );
    expect(es.length).toBe(3);
    expect(es[0].title).toBe(
      "Special Section on Log Data Usage Technology（IEICE Trans. Inf. & Syst. 特集号）",
    );
    expect(es[0].date_text).toBe("2026-11-12");
    expect(es[0].year).toBe(2026);
    expect(es[2].date_text).toBe("2024-03-01"); // 過去締切も行としては拾う (フィルタは呼び出し側)
  });
});

describe("parseIpsjCfpHtml", () => {
  it("extracts special issues and skips closed ones", () => {
    const html =
      '<a href="cfp/27-P.html">' +
      "<article><h3>論文誌「ユビキタスコンピューティングシステム（XIV）」特集 論文募集</h3>" +
      "<p>投稿締切：2026年12月4日（金）</p></article></a>" +
      '<a href="cfp/27-K.html">' +
      "<article><h3>論文誌「未知の世界に挑むインターネットと運用管理技術」特集 論文募集</h3>" +
      "<p>論文募集は終了しました。</p></article></a>";
    const es = parseIpsjCfpHtml(html, "https://www.ipsj.or.jp/journal/index.html");
    expect(es.length).toBe(1); // 終了分はスキップ
    expect(es[0].key).toBe("ipsj-27-p"); // 日本語タイトルでも key は一意 (slug 衝突回避)
    expect(es[0].title).toBe("ユビキタスコンピューティングシステム（XIV）（IPSJ 論文誌 特集号）");
    expect(es[0].date_text).toBe("2026-12-04");
    expect(es[0].year).toBe(2026);
    expect(es[0].link).toBe("https://www.ipsj.or.jp/journal/cfp/27-P.html");
  });

  it("decodes HTML entities in the journal name", () => {
    const html =
      '<a href="cfp/27-Q.html">' +
      "<article><h3>論文誌「情報処理 &amp; システム」特集 論文募集</h3>" +
      "<p>投稿締切：2026年5月15日（金）</p></article></a>";
    const es = parseIpsjCfpHtml(html, "https://www.ipsj.or.jp/journal/index.html");
    expect(es.length).toBe(1);
    expect(es[0].title).toBe("情報処理 & システム（IPSJ 論文誌 特集号）");
  });
});

describe("review helpers", () => {
  it("is_predatory / norm_title", () => {
    expect(isPredatory("ICDIACS 2026, Ei Compendex and Scopus indexed")).toBe(true);
    expect(isPredatory("PARMA-DITAM 2027 Glasgow")).toBe(false);
    expect(normTitle("SIGSPATIAL 2026")).toBe(normTitle("SIGSPATIAL 2027"));
    expect(normTitle("GeoAI'26")).toBe(normTitle("GeoAI 2026"));
    expect(normTitle("SC ’26")).toBe("sc");
    expect(normTitle("情報処理学会 HPC 研究会 2026年")).toBe("情報処理学会 hpc 研究会");
    expect(normTitle("ソフトウェア工学の基礎ワークショップ (FOSE 2026)")).toBe(
      "ソフトウェア工学の基礎ワークショップ fose",
    );
    expect(normTitle("ソフトウェア工学の基礎ワークショップ")).toBe(
      "ソフトウェア工学の基礎ワークショップ",
    );
    expect(normTitle("   ")).toBe("");
    expect(normTitle(null)).toBe("");
  });

  it("parseReviewArgs handles flags, --help, and --now", () => {
    const res1 = parseReviewArgs([
      "--candidates=custom.yaml",
      "--limit=25",
      "--now=2026-08-09T00:00:00Z",
    ]);
    expect(res1.candidates).toBe("custom.yaml");
    expect(res1.limit).toBe(25);
    expect(res1.now.toISOString()).toBe("2026-08-09T00:00:00.000Z");
    expect(res1.help).toBe(false);

    const res2 = parseReviewArgs([
      "--candidates",
      "foo.yaml",
      "--limit",
      "10",
      "--now",
      "2026-09-01T12:00:00Z",
    ]);
    expect(res2.candidates).toBe("foo.yaml");
    expect(res2.limit).toBe(10);
    expect(res2.now.toISOString()).toBe("2026-09-01T12:00:00.000Z");

    const res3 = parseReviewArgs(["--help"]);
    expect(res3.help).toBe(true);
  });

  it("parseReviewArgs rejects impossible calendar dates in --now (2026-02-30 等)", () => {
    expect(() => parseReviewArgs(["--now=2026-02-30T00:00:00Z"])).toThrow("unparsable --now");
    expect(() => parseReviewArgs(["--now", "2026-04-31T00:00:00Z"])).toThrow("unparsable --now");
    expect(() => parseReviewArgs(["-n", "2026-02-29T00:00:00Z"])).toThrow("unparsable --now");
    // 有効値は従来どおり受理される
    const ok = parseReviewArgs(["--now=2026-08-09T00:00:00Z"]);
    expect(ok.now.toISOString()).toBe("2026-08-09T00:00:00.000Z");
  });

  it("reviewDeadlineText falls back through submission_deadline_text, ed.date_text, c.date_text, and deadlines", () => {
    // 1. submission_deadline_text priority
    expect(
      reviewDeadlineText({
        submission_deadline_text: "2026-05-01",
        date_text: "2026-06-01",
        editions: [{ date_text: "2026-07-01" }],
      }),
    ).toBe("2026-05-01");

    // 2. ed.date_text priority over c.date_text
    expect(
      reviewDeadlineText({
        date_text: "2026-06-01",
        editions: [{ date_text: "2026-07-01" }],
      }),
    ).toBe("2026-07-01");

    // 3. c.date_text when no edition date_text
    expect(
      reviewDeadlineText({
        date_text: "2026-06-01",
        editions: [],
      }),
    ).toBe("2026-06-01");

    // 4. deadlines array fallback (.date, .utc, .deadline)
    expect(
      reviewDeadlineText({
        deadlines: [{ date: "2026-08-15 23:59:00" }],
      }),
    ).toBe("2026-08-15 23:59:00");
    expect(
      reviewDeadlineText({
        deadlines: [{ utc: "2026-08-15T23:59:00Z" }],
      }),
    ).toBe("2026-08-15T23:59:00Z");
    expect(
      reviewDeadlineText({
        editions: [{ deadlines: [{ deadline: "2026-09-01" }] }],
      }),
    ).toBe("2026-09-01");
  });

  it("loadTrackedTitles tracks titles, full names, keys, and overrides", () => {
    const tracked = loadTrackedTitles();
    expect(tracked.size).toBeGreaterThan(0);
    expect(tracked.has("sigcomm")).toBe(true);
    expect(tracked.has("isc hpc")).toBe(true);
  });

  it("runReviewCandidates gracefully handles missing candidate files", () => {
    expect(() => {
      runReviewCandidates("/tmp/nonexistent-candidates-999.yaml", 60, new Date());
    }).not.toThrow();
  });

  it("parseReviewArgs handles short flags -c, -l, -n and --flags", () => {
    const res = parseReviewArgs([
      "-c",
      "/tmp/custom-candidates.yaml",
      "-l",
      "25",
      "-n",
      "2026-09-01T00:00:00Z",
    ]);
    expect(res.candidates).toBe("/tmp/custom-candidates.yaml");
    expect(res.limit).toBe(25);
    expect(res.now.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(res.help).toBe(false);

    const resEq = parseReviewArgs(["-C=/tmp/custom2.yaml", "-l=30", "-n=2026-09-15T00:00:00Z"]);
    expect(resEq.candidates).toBe("/tmp/custom2.yaml");
    expect(resEq.limit).toBe(30);
    expect(resEq.now.toISOString()).toBe("2026-09-15T00:00:00.000Z");
  });

  it("normTitle, isPredatory, and reviewDeadlineText handle null/undefined defensively", () => {
    expect(normTitle(null)).toBe("");
    expect(normTitle(undefined)).toBe("");
    expect(isPredatory(null)).toBe(false);
    expect(isPredatory(undefined)).toBe(false);
    expect(reviewDeadlineText(null)).toBe("");
    expect(reviewDeadlineText(undefined)).toBe("");
    expect(reviewDeadlineText({})).toBe("");
  });

  it("tagSource extracts source string from arrays and strings defensively (#296)", () => {
    expect(tagSource(["niche", "wikicfp"])).toBe("wikicfp");
    expect(tagSource("wikicfp")).toBe("wikicfp");
    expect(tagSource(["dbworld"])).toBe("dbworld");
    expect(tagSource(null)).toBe("?");
    expect(tagSource(undefined)).toBe("?");
    expect(tagSource([])).toBe("?");
    expect(tagSource([""])).toBe("?");
  });

  it("parseDeadlineText parses NFKC full-width dates and 'of' prepositions (#280)", () => {
    expect(parseDeadlineText("15th of May, 2026")?.toISOString().slice(0, 10)).toBe("2026-05-15");
    expect(parseDeadlineText("15th of May 2026")?.toISOString().slice(0, 10)).toBe("2026-05-15");
    expect(parseDeadlineText("２０２６年５月１５日")?.toISOString().slice(0, 10)).toBe(
      "2026-05-15",
    );
    expect(parseDeadlineText("2026年05月15日")?.toISOString().slice(0, 10)).toBe("2026-05-15");
    expect(parseDeadlineText("2026年5月15日 (金)")?.toISOString().slice(0, 10)).toBe("2026-05-15");
    expect(parseDeadlineText("Aug 15, 2026 (Aug 1, 2026)")?.toISOString().slice(0, 10)).toBe(
      "2026-08-15",
    );
  });

  it("extractDeadlinesFromText handles NFKC full-width numbers and dates (#298)", () => {
    const res1 = extractDeadlinesFromText("Paper submission: ２０２６年５月１５日");
    expect(res1.length).toBe(1);
    expect(res1[0].date).toBe("2026-05-15 23:59:00");

    const res2 = extractDeadlinesFromText("Submission: ２０２６/０８/２０");
    expect(res2.length).toBe(1);
    expect(res2[0].date).toBe("2026-08-20 23:59:00");

    expect(extractDeadlinesFromText(null)).toEqual([]);
    expect(extractDeadlinesFromText(undefined)).toEqual([]);
    expect(extractDeadlinesFromText("")).toEqual([]);
  });
});

const WIKICFP_SAMPLE = `<html><body>
<table>
<tr><td><a href="/cfp/servlet/event.showcfp?eventid=1&amp;copyownerid=2">FAKECONF 2026</a></td><td>International Conference on Fake Systems</td></tr>
<tr><td>Mar 1, 2026 - Mar 3, 2026</td><td>Tokyo, Japan</td><td>Feb 1, 2026</td></tr>
<tr><td><a href="/cfp/servlet/event.showcfp?eventid=3">NOBODY 2027</a></td><td>Workshop on Nothing</td></tr>
<tr><td>N/A</td><td>N/A</td><td>N/A</td></tr>
<tr><td><a href="/cfp/servlet/event.showcfp?eventid=4">OLD 2024</a></td><td>Past Conference</td></tr>
<tr><td>N/A</td><td>N/A</td><td>Dec 1, 2024</td></tr>
</table></body></html>`;

describe("parseWikiCfpHtml", () => {
  it("keeps only future in-domain entries", () => {
    const entries = parseWikiCfpHtml(WIKICFP_SAMPLE, ["systems"], 2026);
    expect(entries.length).toBe(1); // NOBODY(N/A) と OLD(2024) は除外される
    const e = entries[0];
    expect(e.key).toBe("fakeconf-2026");
    expect(e.title).toBe("FAKECONF 2026");
    expect(e.full_name).toBe("International Conference on Fake Systems");
    expect(e.link).toBe(
      "https://www.wikicfp.com/cfp/servlet/event.showcfp?eventid=1&copyownerid=2",
    );
    expect(e.categories).toEqual(["systems"]);
    expect(e.date_text).toBe("Feb 1, 2026");
    expect(e.place).toBe("Tokyo, Japan");
    expect(e.year).toBe(2026);
  });

  it("decodes HTML entities in the full_name cell", () => {
    const html =
      "<table>" +
      '<tr><td><a href="/cfp/servlet/event.showcfp?eventid=99&amp;copyownerid=1">XYZ 2026</a></td>' +
      "<td>International Conference on Computing &amp; Systems</td></tr>" +
      "<tr><td>Mar 1, 2026 - Mar 3, 2026</td><td>Tokyo, Japan</td><td>Feb 1, 2026</td></tr>" +
      "</table></body></html>";
    const entries = parseWikiCfpHtml(html, ["systems"], 2026);
    expect(entries.length).toBe(1);
    expect(entries[0].full_name).toBe("International Conference on Computing & Systems");
  });

  it("toYamlDict は開催年 (entry.year) を優先し、締切日 (date_text) の年で上書きしない", () => {
    // DASFAA 2026: タイトルが開催年 2026、締切が前年 (Oct 27, 2025)
    const html =
      "<table>" +
      '<tr><td><a href="/cfp/servlet/event.showcfp?eventid=1&copyownerid=2">DASFAA 2026</a></td>' +
      "<td>The 31st International Conference on Database Systems for Advanced Application</td></tr>" +
      "<tr><td>Jeju, South Korea</td><td>Oct 27, 2025</td><td>Oct 27, 2025 (Oct 20, 2025)</td></tr>" +
      "</table></body></html>";
    const entries = parseWikiCfpHtml(html, ["databases"], 2026);
    expect(entries.length).toBe(1);
    expect(entries[0].year).toBe(2026);
    const cand = makeCandidate({
      key: entries[0].key,
      title: entries[0].title,
      full_name: entries[0].full_name,
      link: entries[0].link,
      categories: entries[0].categories,
      tags: ["niche", "wikicfp"],
      source_type: "conference",
      evidence_url: "https://www.wikicfp.com",
      date_text: entries[0].date_text,
      place: entries[0].place,
      year: entries[0].year,
    });
    const dict = toYamlDict(cand);
    const edition = (dict.editions as Array<Record<string, unknown>>)[0];
    // 開催年 2026 が締切年 2025 に上書きされない（回帰: dasfaa-202625 の誤り）
    expect(edition.year).toBe(2026);
    expect(edition.id).toBe("dasfaa-202626");
    // 締切日そのものは date_text として保持される
    expect(edition.date_text).toBe("Oct 27, 2025 (Oct 20, 2025)");
  });

  it("toYamlDict は year が無い候補で date_text から年を導出する (従来動作)", () => {
    const cand = makeCandidate({
      key: "tconf",
      title: "Test Conf",
      full_name: "Test Conference",
      link: "https://example.org",
      categories: ["systems"],
      date_text: "May 10, 2027",
    });
    const dict = toYamlDict(cand);
    const edition = (dict.editions as Array<Record<string, unknown>>)[0];
    expect(edition.year).toBe(2027);
    expect(edition.id).toBe("tconf27");
  });
});

describe("extractDeadlinesFromText", () => {
  it("extracts ISO and slash dates in order", () => {
    const text = "Submission deadline: 2026-05-15. Notification: 2026/07/01.";
    const dls = extractDeadlinesFromText(text);
    expect(dls.length).toBe(2);
    expect(dls[0]).toEqual({
      kind: "paper",
      label: "Submission Deadline",
      date: "2026-05-15 23:59:00",
      tz: "AoE",
    });
    expect(dls[1]).toEqual({
      kind: "notification",
      label: "Notification Date",
      date: "2026-07-01 23:59:00",
      tz: "AoE",
    });
  });

  it("extracts English month dates and Day Month Year forms", () => {
    const text = "Paper deadline: May 15, 2026. Notification date: 1st of July 2026.";
    const dls = extractDeadlinesFromText(text);
    expect(dls.length).toBe(2);
    expect(dls[0].date).toBe("2026-05-15 23:59:00");
    expect(dls[1].date).toBe("2026-07-01 23:59:00");
  });

  it("extracts European numeric and Japanese format dates", () => {
    const text = "締切: 2026年5月15日 (再延長: 31.05.2026)";
    const dls = extractDeadlinesFromText(text);
    expect(dls.length).toBe(2);
    expect(dls[0].date).toBe("2026-05-15 23:59:00");
    expect(dls[1].date).toBe("2026-05-31 23:59:00");
  });

  it("returns empty array for text with no valid calendar dates", () => {
    expect(extractDeadlinesFromText("")).toEqual([]);
    expect(extractDeadlinesFromText("Deadline: TBA")).toEqual([]);
    expect(extractDeadlinesFromText("2026-02-30")).toEqual([]);
  });
});

describe("parseDeadlineText", () => {
  it.each([
    ["15-May-2026", 2026, 5, 15],
    ["15/May/2026", 2026, 5, 15],
    ["May-15-2026", 2026, 5, 15],
    ["August 15th, 2026", 2026, 8, 15],
    ["15th August, 2026", 2026, 8, 15],
    ["aug 15, 2026", 2026, 8, 15],
    ["AUG 15, 2026", 2026, 8, 15],
    ["Submission deadline: 2026/08/20 (AoE)", 2026, 8, 20],
    ["2026.05.15", 2026, 5, 15],
    ["2026-05-15", 2026, 5, 15],
    ["2026年5月15日", 2026, 5, 15],
  ])("parses %j -> %d-%02d-%02d", (text, y, m, d) => {
    const res = parseDeadlineText(text);
    expect(res).not.toBeNull();
    expect(res?.toISOString().slice(0, 10)).toBe(
      `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
    );
  });

  it("returns null for unparsable or empty strings", () => {
    expect(parseDeadlineText("")).toBeNull();
    expect(parseDeadlineText("TBD")).toBeNull();
    expect(parseDeadlineText("2026-02-30")).toBeNull();
  });
});

describe("deadlineIsFuture", () => {
  it("compares against today", () => {
    const today = utcDate(2026, 8, 10);
    expect(deadlineIsFuture("Aug 14, 2026", today)).toBe(true);
    expect(deadlineIsFuture("aug 14, 2026", today)).toBe(true);
    expect(deadlineIsFuture("15-Sep-2026", today)).toBe(true);
    expect(deadlineIsFuture("August 15th, 2026", today)).toBe(true);
    expect(deadlineIsFuture("Submission deadline: 2026/08/20 (AoE)", today)).toBe(true);
    expect(deadlineIsFuture("Aug 9, 2026", today)).toBe(false);
    expect(deadlineIsFuture("Dec 1, 2026 (Nov 15, 2026)", today)).toBe(true);
    expect(deadlineIsFuture("Feb 1, 2026", today)).toBe(false);
    expect(deadlineIsFuture("TBA", today)).toBe(false); // 形式不明は候補にしない
    expect(deadlineIsFuture("Mar 15, 2027", today)).toBe(true);
  });

  it("treats impossible calendar dates as not future", () => {
    const today = utcDate(2026, 8, 10);
    expect(deadlineIsFuture("2026-02-30", today)).toBe(false);
    expect(deadlineIsFuture("2026年2月30日", today)).toBe(false);
    expect(deadlineIsFuture("30 February 2026", today)).toBe(false);
    expect(deadlineIsFuture("Feb 30, 2026", today)).toBe(false);
    expect(deadlineIsFuture("April 31, 2026", today)).toBe(false);
    expect(deadlineIsFuture("Feb 29, 2025", today)).toBe(false);
  });
});

describe("discover and review boundary handling", () => {
  it("toYamlDict and formatDiscoveredYaml handle null/undefined arguments safely", () => {
    expect(toYamlDict(null)).toEqual({});
    expect(toYamlDict(undefined)).toEqual({});
    expect(formatDiscoveredYaml(null)).toContain("conferences: []");
    expect(formatDiscoveredYaml(undefined)).toContain("conferences: []");
  });

  it("all discover HTML parsers handle null/undefined inputs defensively", () => {
    expect(parseWikiCfpHtml(null, null, 2026)).toEqual([]);
    expect(parseWikiCfpHtml(undefined, undefined, 2026)).toEqual([]);
    expect(parseDbworldHtml(null)).toEqual([]);
    expect(parseDbworldHtml(undefined)).toEqual([]);
    expect(cleanDbworldTitle(null)).toEqual(["", "conference"]);
    expect(cleanDbworldTitle(undefined)).toEqual(["", "conference"]);
    expect(parseEasyChairCfpHtml(null)).toEqual([]);
    expect(parseEasyChairCfpHtml(undefined)).toEqual([]);
    expect(inDomain(null)).toBe(false);
    expect(inDomain(undefined)).toBe(false);
    expect(easyChairEntriesFromRows(null, 2026)).toEqual([]);
    expect(easyChairEntriesFromRows(undefined, 2026)).toEqual([]);
    expect(parseComsocCfpHtml(null, "Test", "https://example.com")).toEqual([]);
    expect(parseIeiceCfpHtml(null, "https://example.com")).toEqual([]);
    expect(parseIpsjCfpHtml(null, "https://example.com")).toEqual([]);
  });

  it("parseReviewArgs handles null/undefined arguments safely", () => {
    const res = parseReviewArgs(null);
    expect(res.candidates).toBeDefined();
    expect(res.limit).toBe(60);
    expect(res.help).toBe(false);
  });

  it("loadTrackedTitles and runReviewCandidates accept custom root and resolve relative paths (#316)", () => {
    const trackedDefault = loadTrackedTitles(REPO_ROOT);
    expect(trackedDefault.size).toBeGreaterThan(0);
    expect(trackedDefault.has("sigcomm") || trackedDefault.has("isc hpc")).toBe(true);

    // Empty custom root returns empty set gracefully without throwing
    const trackedEmpty = loadTrackedTitles("/tmp/nonexistent-root-dir-999");
    expect(trackedEmpty.size).toBe(0);

    // runReviewCandidates with relative path against custom root
    expect(() => {
      runReviewCandidates(
        "data/discovered_candidates.yaml",
        10,
        new Date("2026-08-09T00:00:00Z"),
        REPO_ROOT,
      );
    }).not.toThrow();
  });

  it("parseIpsjCfpHtml resolves root-relative and document-relative links without duplicate path segments (#318)", () => {
    const html = `
      <div>
        <a href="/journal/cfp/ipsj-27-p.html">論文誌「量子情報処理」特集 投稿締切：2026年10月15日</a>
        <a href="cfp/ipsj-28-p.html">論文誌「システムソフトウェア」特集 投稿締切：2026年11月20日</a>
      </div>
    `;
    const res = parseIpsjCfpHtml(html, "https://www.ipsj.or.jp/journal/index.html");
    expect(res).toHaveLength(2);
    expect(res[0].link).toBe("https://www.ipsj.or.jp/journal/cfp/ipsj-27-p.html");
    expect(res[1].link).toBe("https://www.ipsj.or.jp/journal/cfp/ipsj-28-p.html");
  });

  it("isAlreadyTracked, classifyCategory, and deadlineIsFuture handle null/undefined safely (#344)", () => {
    const disc = new NicheDiscoverer(REPO_ROOT);
    expect(disc.isAlreadyTracked(null)).toBe(false);
    expect(disc.isAlreadyTracked(undefined)).toBe(false);
    expect(disc.isAlreadyTracked("")).toBe(false);

    expect(disc.classifyCategory(null)).toEqual(["systems"]);
    expect(disc.classifyCategory(undefined)).toEqual(["systems"]);
    expect(disc.classifyCategory("")).toEqual(["systems"]);

    expect(deadlineIsFuture(null, null)).toBe(false);
    expect(deadlineIsFuture(undefined, null)).toBe(false);
    expect(deadlineIsFuture("2099-12-31", null)).toBe(true);
    expect(deadlineIsFuture("1990-01-01", null)).toBe(false);
  });
});
