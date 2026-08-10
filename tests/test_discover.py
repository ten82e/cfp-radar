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

