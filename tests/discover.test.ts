/**
 * discover.ts / review-candidates.ts のテスト。
 * Ported from tests/test_discover.py.
 */

import { describe, expect, it } from "vitest";
import {
  cleanDbworldTitle,
  deadlineIsFuture,
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
} from "../src/discover.ts";
import { isPredatory, normTitle } from "../src/review-candidates.ts";
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

  it("classify category", () => {
    const hpc = discoverer.classifyCategory(
      "International Workshop on High Performance Computing Interconnects",
    );
    expect(hpc).toContain("hpc");
    const sec = discoverer.classifyCategory(
      "IEEE Workshop on System Security and Confidential Computing",
    );
    expect(sec.includes("security") || sec.includes("systems")).toBe(true);
  });

  it("run discovery returns candidates with required fields", async () => {
    const cands = await discoverer.runDiscovery(["systems"], 2026);
    for (const c of cands) {
      expect(c.key).toBeTruthy();
      expect(c.title).toBeTruthy();
      expect(c.link).toBeTruthy();
    }
  }, 120_000);
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
    expect(parseDeadlineText("November, 2026")).toBeNull(); // 月のみはでっち上げない
    expect(parseDeadlineText("unknown")).toBeNull();
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
});

describe("review helpers", () => {
  it("is_predatory / norm_title", () => {
    expect(isPredatory("ICDIACS 2026, Ei Compendex and Scopus indexed")).toBe(true);
    expect(isPredatory("PARMA-DITAM 2027 Glasgow")).toBe(false);
    expect(normTitle("SIGSPATIAL 2026")).toBe(normTitle("SIGSPATIAL 2027"));
    expect(normTitle("GeoAI'26")).toBe(normTitle("GeoAI 2026"));
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
});

describe("deadlineIsFuture", () => {
  it("compares against today", () => {
    const today = utcDate(2026, 8, 10);
    expect(deadlineIsFuture("Aug 14, 2026", today)).toBe(true);
    expect(deadlineIsFuture("Aug 9, 2026", today)).toBe(false);
    expect(deadlineIsFuture("Dec 1, 2026 (Nov 15, 2026)", today)).toBe(true);
    expect(deadlineIsFuture("Feb 1, 2026", today)).toBe(false);
    expect(deadlineIsFuture("TBA", today)).toBe(false); // 形式不明は候補にしない
    expect(deadlineIsFuture("Mar 15, 2027", today)).toBe(true);
  });
});
