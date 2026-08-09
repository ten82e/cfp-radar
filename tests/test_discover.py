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

