"""Tests for scripts/discover.py."""

from pathlib import Path
from scripts.discover import DiscoveredCandidate, NicheDiscoverer, format_discovered_yaml

ROOT = Path(__file__).resolve().parent.parent


def test_niche_discoverer_initialization():
    discoverer = NicheDiscoverer(ROOT)
    assert len(discoverer.known_keys) > 0
    # Common known keys should be tracked
    assert "sigcomm" in discoverer.known_keys or "isc-hpc" in discoverer.known_keys


def test_already_tracked_check():
    discoverer = NicheDiscoverer(ROOT)
    assert discoverer.is_already_tracked("sigcomm") is True
    assert discoverer.is_already_tracked("isc-hpc") is True
    assert discoverer.is_already_tracked("completely-unknown-fake-niche-venue-999") is False


def test_classify_category():
    discoverer = NicheDiscoverer(ROOT)
    cats_hpc = discoverer.classify_category("International Workshop on High Performance Computing Interconnects")
    assert "hpc" in cats_hpc

    cats_sec = discoverer.classify_category("IEEE Workshop on System Security and Confidential Computing")
    assert "security" in cats_sec or "systems" in cats_sec


def test_format_discovered_yaml():
    cand = DiscoveredCandidate(
        key="nvmw",
        title="NVMW",
        full_name="Non-Volatile Memories Workshop",
        link="https://nvmw.ucsd.edu/",
        categories=["systems"],
        tags=["niche", "workshop"],
        place="San Diego, CA, USA",
        date_text="March 8-10, 2026",
    )
    yaml_text = format_discovered_yaml([cand])
    assert "key: nvmw" in yaml_text
    assert "title: NVMW" in yaml_text
    assert "Non-Volatile Memories Workshop" in yaml_text


def test_extract_deadlines_from_text():
    from scripts.discover import extract_deadlines_from_text
    text = "Paper submission is due by 2026-05-15 and notification date is 2026-07-20."
    deadlines = extract_deadlines_from_text(text)
    assert len(deadlines) == 2
    assert deadlines[0]["kind"] == "paper"
    assert deadlines[0]["date"] == "2026-05-15 23:59:00"
    assert deadlines[1]["kind"] == "notification"
    assert deadlines[1]["date"] == "2026-07-20 23:59:00"


def test_parse_dbworld_html_and_clean():
    from scripts.discover import parse_dbworld_html, clean_dbworld_title

    html = """<TABLE><TBODY>
<TR VALIGN=TOP><TD>Sun, 9 Aug 2026 18:22:00 +0000</TD><TD>X</TD>
<TD><A HREF=https://listserv.acm.org/SCRIPTS/WA-ACMLPX.CGI?A2=MOD-DBWORLD;ff70>INDIS 2026: Paper Submission Deadline Extended to August 3</A></TD></TR>
<TR VALIGN=TOP><TD>Mon, 10 Aug 2026 09:00:00 +0000</TD><TD>Y</TD>
<TD><A HREF=https://listserv.acm.org/x>PDP 2027  Call for Papers &amp; Call for Special Sessions</A></TD></TR>
<TR VALIGN=TOP><TD>Mon, 10 Aug 2026 09:10:00 +0000</TD><TD>Z</TD>
<TD><A HREF=https://listserv.acm.org/y>Some random announcement</A></TD></TR>
<TR VALIGN=TOP><TD>Mon, 10 Aug 2026 09:20:00 +0000</TD><TD>W</TD>
<TD><A HREF=https://listserv.acm.org/z>[DEADLINE EXTENDED] AI4DEMONS 2026@CIKM2026</A></TD></TR>
</TBODY></TABLE>"""
    items = parse_dbworld_html(html)
    assert len(items) == 3  # CFP/DEADLINE 関連のみ
    assert items[0][0] == "INDIS 2026: Paper Submission Deadline Extended to August 3"
    assert items[1][0] == "PDP 2027  Call for Papers & Call for Special Sessions"

    assert clean_dbworld_title("INDIS 2026: Paper Submission Deadline Extended to August 3")[0] == "INDIS 2026"
    assert clean_dbworld_title("PDP 2027  Call for Papers & Call for Special Sessions")[0] == "PDP 2027"
    assert clean_dbworld_title("[DEADLINE EXTENDED] AI4DEMONS 2026@CIKM2026")[0] == "AI4DEMONS 2026@CIKM2026"
    assert clean_dbworld_title("iiWAS 2026 || Submission Deadline: 1 August 2026 (Final) || Bangkok")[0] == "iiWAS 2026"
    assert clean_dbworld_title("Call for Papers: ACM SIGSPATIAL 2026 Workshops & Competitions")[0] == "ACM SIGSPATIAL 2026 Workshops & Competitions"
    assert clean_dbworld_title("[Reminder] ACM TWEB Special Issue on the Agentic Web (Deadline: Sept. 30, 2026)")[1] == "journal"
    # 残課題ケース (2026-08-10 実データから)
    assert clean_dbworld_title("Last CFP: SIMBig 2026 | NAACL Awards | Deadline (Aug 7)")[0] == "SIMBig 2026"
    assert clean_dbworld_title("Deadline extended: ER 2026 Call for Doctoral Symposium Papers")[0] == "ER 2026"
    assert clean_dbworld_title("Extended Submission Deadline  DTSSB 2026 Workshop @ BIR 2026 (August 16)")[0].startswith("DTSSB 2026")
    assert clean_dbworld_title("DEADLINE EXTENSION ICAIF 2026  ACM International Conference on AI in Finance")[0] == "ICAIF 2026 ACM International Conference on AI in Finance"
    assert clean_dbworld_title("CfP Special Issue on Lakehouse Systems in GI Datenbankspektrum")[0].startswith("Special Issue")
    assert clean_dbworld_title("– CRiSIS 2026 (Rabat, Morocco) – Extended deadline")[0] == "CRiSIS 2026 (Rabat, Morocco)"
    assert clean_dbworld_title("[DEADLINE APPROACHING][CWN'26] Thirteenth International Workshop on Cooperative Wireless Networks")[0] == "Thirteenth International Workshop on Cooperative Wireless Networks"


def test_run_discovery_integration():
    discoverer = NicheDiscoverer(ROOT)
    cands = discoverer.run_discovery(categories=["systems"])
    assert isinstance(cands, list)
    # Ensure fallback or DBLP candidates exist and have required fields
    for c in cands:
        assert c.key
        assert c.title
        assert c.link


WIKICFP_SAMPLE = """<html><body>
<table>
<tr><td><a href="/cfp/servlet/event.showcfp?eventid=1&amp;copyownerid=2">FAKECONF 2026</a></td><td>International Conference on Fake Systems</td></tr>
<tr><td>Mar 1, 2026 - Mar 3, 2026</td><td>Tokyo, Japan</td><td>Feb 1, 2026</td></tr>
<tr><td><a href="/cfp/servlet/event.showcfp?eventid=3">NOBODY 2027</a></td><td>Workshop on Nothing</td></tr>
<tr><td>N/A</td><td>N/A</td><td>N/A</td></tr>
<tr><td><a href="/cfp/servlet/event.showcfp?eventid=4">OLD 2024</a></td><td>Past Conference</td></tr>
<tr><td>N/A</td><td>N/A</td><td>Dec 1, 2024</td></tr>
</table></body></html>"""


def test_parse_wikicfp_html():
    from scripts.discover import parse_wikicfp_html

    entries = parse_wikicfp_html(WIKICFP_SAMPLE, ["systems"], min_year=2026)
    assert len(entries) == 1, entries  # NOBODY(N/A) と OLD(2024) は除外される
    e = entries[0]
    assert e["key"] == "fakeconf-2026"
    assert e["title"] == "FAKECONF 2026"
    assert e["full_name"] == "International Conference on Fake Systems"
    assert e["link"] == "https://www.wikicfp.com/cfp/servlet/event.showcfp?eventid=1&copyownerid=2"
    assert e["categories"] == ["systems"]
    assert e["date_text"] == "Feb 1, 2026"
    assert e["place"] == "Tokyo, Japan"
    assert e["year"] == 2026


def test_deadline_is_future():
    from datetime import date
    from scripts.discover import _deadline_is_future

    today = date(2026, 8, 10)
    assert _deadline_is_future("Aug 14, 2026", today) is True
    assert _deadline_is_future("Aug 9, 2026", today) is False
    assert _deadline_is_future("Dec 1, 2026 (Nov 15, 2026)", today) is True
    assert _deadline_is_future("Feb 1, 2026", today) is False
    assert _deadline_is_future("TBA", today) is False  # 形式不明は候補にしない
    assert _deadline_is_future("Mar 15, 2027", today) is True

