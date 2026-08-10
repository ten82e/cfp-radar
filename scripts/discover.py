"""Autonomous Discovery Engine for Niche Conferences & Journals.

This module searches external academic CFP sources (DBLP, WikiCFP, OpenReview,
Call4Paper, IEEE/ACM CFP lists) for niche conferences, workshops, symposia,
and journal Call for Papers in HPC, Systems, Networking, AI, and Security.
"""

from __future__ import annotations

import json
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from .model import slug

ROOT = Path(__file__).resolve().parent.parent

# Domain-specific keywords for classifying niche venues
DOMAIN_KEYWORDS: dict[str, list[str]] = {
    "hpc": [
        "hpc", "supercomputing", "parallel computing", "high performance",
        "interconnect", "cluster computing", "grid computing", "heterogeneous computing",
    ],
    "systems": [
        "operating systems", "storage systems", "embedded systems", "real-time",
        "computer architecture", "cloud computing", "edge computing", "virtualization",
        "compiler", "code generation", "memory systems", "dependable systems",
    ],
    "networking": [
        "computer networks", "network protocols", "programmable networks", "wireless networking",
        "sdn", "p4", "network management", "mobile computing", "optical networking",
    ],
    "ai": [
        "machine learning systems", "sysml", "graph neural networks", "ai systems",
        "deep learning systems", "efficient ai", "neural networks", "robotics systems",
    ],
    "security": [
        "system security", "network security", "privacy", "hardware security",
        "cryptography", "binary analysis", "confidential computing", "trustworthy ai",
    ],
}

# Indicators of niche/obscure venues & journals
NICHE_KEYWORDS = [
    "workshop", "symposium", "journal", "special issue", "letters", "transactions",
    "regional", "open call", "forum", "work-in-progress", "short papers",
]

# wikiCFP のカテゴリページ (?conference=<cat>) と cfp-radar カテゴリの対応。
# wikiCFP は締切の一次情報ではない(ユーザー投稿)ため、候補発見のみに使い、
# 収録の裏取り(公式サイト HTTP 確認)は人間のレビュー工程で行う。
WIKICFP_CATEGORY_MAP: dict[str, list[str]] = {
    "hpc": ["parallel", "high", "grid", "performance"],
    "networking": ["networks", "networking", "communications", "internet", "wireless"],
    "systems": ["systems", "architecture", "operating", "distributed", "embedded", "cloud", "edge"],
    "ai": ["artificial", "machine", "deep", "neural", "intelligent"],
    "security": ["security", "cybersecurity", "privacy", "cryptography"],
    "db": ["database", "databases", "data", "big"],
    "graphics": ["graphics", "multimedia", "visualization"],
    "hci": ["human"],
    "theory": ["theory", "algorithms", "theoretical", "complexity", "formal", "verification"],
}


@dataclass
class DiscoveredCandidate:
    key: str
    title: str
    full_name: str
    link: str
    categories: list[str]
    tags: list[str] = field(default_factory=lambda: ["niche"])
    source_type: str = "conference"  # 'conference' or 'journal'
    evidence_url: str = ""
    date_text: str = ""
    place: str = ""
    deadlines: list[dict[str, Any]] = field(default_factory=list)

    def to_yaml_dict(self) -> dict[str, Any]:
        """Convert entry into data/extra.yaml format."""
        entry: dict[str, Any] = {
            "key": self.key,
            "title": self.title,
            "full_name": self.full_name,
            "link": self.link,
            "categories": self.categories,
        }
        if self.tags:
            entry["tags"] = self.tags
        editions = []
        if self.date_text or self.place or self.deadlines:
            import re
            m = re.search(r"(20\d\d)", self.date_text)
            year = int(m.group(1)) if m else 2026
            ed_dict: dict[str, Any] = {
                "year": year,
                "id": f"{self.key}{year % 100}",
                "link": self.link,
                "place": self.place or "",
                "date_text": self.date_text or "",
                "deadlines": self.deadlines,
            }
            editions.append(ed_dict)
        entry["editions"] = editions
        return entry


def extract_deadlines_from_text(text: str) -> list[dict[str, Any]]:
    """Extract structured deadline dates from text if ISO or standard date formats appear."""
    deadlines: list[dict[str, Any]] = []
    import re
    matches = re.findall(r'(\b202[6-9]-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\b)', text)
    if matches:
        deadlines.append({
            "kind": "paper",
            "label": "Submission Deadline",
            "date": f"{matches[0]} 23:59:00",
            "tz": "AoE",
        })
        if len(matches) > 1:
            deadlines.append({
                "kind": "notification",
                "label": "Notification Date",
                "date": f"{matches[1]} 23:59:00",
                "tz": "AoE",
            })
    return deadlines


def parse_wikicfp_html(html: str, categories: list[str], min_year: int) -> list[dict]:
    """wikiCFP カテゴリページをパースしてエントリ dict のリストを返す。

    ページは 2 行組で 1 エントリ: (event 行 = title + full name) /
    (detail 行 = when, where, deadline)。締切の裏取りはしない(候補発見のみ)。
    """
    import html as html_mod
    import re

    rows = re.findall(r"<tr[^>]*>(.*?)</tr>", html, re.S)
    entries: list[dict] = []
    i = 0
    while i < len(rows) - 1:
        cells1 = re.findall(r"<td[^>]*>(.*?)</td>", rows[i], re.S)
        cells2 = re.findall(r"<td[^>]*>(.*?)</td>", rows[i + 1], re.S)
        i += 2
        if len(cells1) < 2 or len(cells2) < 3:
            continue
        clean1 = [re.sub(r"<[^>]+>", " ", c) for c in cells1]
        title = re.sub(r"\s+", " ", clean1[0]).strip()
        full_name = re.sub(r"\s+", " ", clean1[1]).strip()
        hrefs = re.findall(r'href="([^"]+)"', cells1[0])
        if not title or not full_name or not hrefs:
            continue
        clean2 = [re.sub(r"<[^>]+>", " ", c) for c in cells2]
        when, where, deadline = (re.sub(r"\s+", " ", c).strip() for c in clean2[:3])
        if deadline in ("", "N/A"):
            continue
        year = min_year
        m = re.search(r"(20\d\d)", title)
        if m:
            year = int(m.group(1))
        else:
            m = re.search(r"(20\d\d)", deadline)
            if m:
                year = int(m.group(1))
        if year < min_year:
            continue
        entries.append({
            "key": slug(title),
            "title": title,
            "full_name": full_name,
            "link": "https://www.wikicfp.com" + html_mod.unescape(hrefs[0]),
            "categories": list(categories),
            "date_text": deadline,
            "place": where if where not in ("", "N/A") else "",
            "year": year,
        })
    return entries


def discover_from_wikicfp_urls(categories: list[str], min_year: int) -> list[dict]:
    """wikiCFP カテゴリページを取得してパースする(ネットワーク層)。"""
    entries: list[dict] = []
    for cat in categories:
        url = f"http://www.wikicfp.com/cfp/call?conference={cat}"
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (cfp-radar-discoverer)"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                html = resp.read().decode("utf-8", "replace")
            entries.extend(parse_wikicfp_html(html, [cat], min_year))
        except Exception:
            # 1 カテゴリの失敗で全体を止めない
            continue
    return entries


class NicheDiscoverer:
    """Discovers niche conferences and journals not yet included in conf-deadlines."""

    def __init__(self, root_dir: Path = ROOT):
        self.root_dir = root_dir
        self.known_keys: set[str] = set()
        self.known_titles: set[str] = set()
        self._load_known_venues()

    def _load_known_venues(self) -> None:
        """Load tracked keys and titles from config.yaml, extra.yaml, and snapshot."""
        # 1. config.yaml taxonomy
        config_path = self.root_dir / "config.yaml"
        if config_path.is_file():
            config = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
            taxonomy = config.get("taxonomy") or {}
            for cat_data in taxonomy.values():
                if isinstance(cat_data, dict):
                    for v in cat_data.get("venues") or []:
                        self.known_keys.add(slug(v))

        # 2. data/extra.yaml
        extra_path = self.root_dir / "data" / "extra.yaml"
        if extra_path.is_file():
            extra = yaml.safe_load(extra_path.read_text(encoding="utf-8")) or {}
            for c in extra.get("conferences") or []:
                if isinstance(c, dict):
                    if "key" in c:
                        self.known_keys.add(slug(c["key"]))
                    if "title" in c:
                        self.known_titles.add(c["title"].lower())

        # 3. data/snapshot.json
        snapshot_path = self.root_dir / "data" / "snapshot.json"
        if snapshot_path.is_file():
            try:
                snap = json.loads(snapshot_path.read_text(encoding="utf-8"))
                for c in snap.get("conferences") or []:
                    if isinstance(c, dict):
                        if "key" in c:
                            self.known_keys.add(slug(c["key"]))
                        if "title" in c:
                            self.known_titles.add(c["title"].lower())
            except (OSError, ValueError):
                pass

    def is_already_tracked(self, key_or_title: str) -> bool:
        """Check if candidate key or title is already in our repository."""
        s = slug(key_or_title)
        if s in self.known_keys:
            return True
        if key_or_title.lower() in self.known_titles:
            return True
        return False

    def classify_category(self, text: str) -> list[str]:
        """Classify candidate text into target categories (hpc, systems, networking, ai, security)."""
        text_lower = text.lower()
        matched: list[str] = []
        for cat, kw_list in DOMAIN_KEYWORDS.items():
            if any(kw in text_lower for kw in kw_list):
                matched.append(cat)
        return matched or ["systems"]

    def discover_from_dblp(self, query: str = "workshop", max_results: int = 30) -> list[DiscoveredCandidate]:
        """Query DBLP API for venue/publication candidates matching query."""
        url = f"https://dblp.org/search/venue/api?q={urllib.parse.quote(query)}&format=json&h={max_results}"
        candidates: list[DiscoveredCandidate] = []
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (cfp-radar-discoverer)"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                hits = data.get("result", {}).get("hits", {}).get("hit", [])
                for hit in hits:
                    info = hit.get("info", {})
                    venue_title = info.get("venue", "") or info.get("acronym", "")
                    venue_url = info.get("url", "")
                    venue_name = info.get("acronym", "") or venue_title

                    if not venue_title or self.is_already_tracked(venue_title):
                        continue

                    cand_key = slug(venue_name or venue_title)
                    if not cand_key or self.is_already_tracked(cand_key):
                        continue

                    categories = self.classify_category(venue_title)
                    source_type = "journal" if "journal" in venue_title.lower() or "transactions" in venue_title.lower() else "conference"

                    cand = DiscoveredCandidate(
                        key=cand_key,
                        title=venue_name or venue_title.upper(),
                        full_name=venue_title,
                        link=venue_url or f"https://dblp.org/db/conf/{cand_key}/index.html",
                        categories=categories,
                        tags=["niche", source_type],
                        source_type=source_type,
                        evidence_url=venue_url,
                    )
                    candidates.append(cand)
                    self.known_keys.add(cand_key)
        except Exception:
            # Soft fallback on network error
            pass
        return candidates

    def discover_from_openreview(self, query: str = "workshop") -> list[DiscoveredCandidate]:
        """Query OpenReview API v2 for venue candidates."""
        url = "https://api2.openreview.net/venues"
        candidates: list[DiscoveredCandidate] = []
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (cfp-radar-discoverer)"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                venues = data.get("venues", [])
                for v in venues:
                    if not isinstance(v, str):
                        continue
                    if query.lower() not in v.lower():
                        continue
                    cand_key = slug(v)
                    if not cand_key or self.is_already_tracked(cand_key) or self.is_already_tracked(v):
                        continue

                    categories = self.classify_category(v)
                    cand = DiscoveredCandidate(
                        key=cand_key,
                        title=v.split("/")[-1].upper(),
                        full_name=v,
                        link=f"https://openreview.net/group?id={v}",
                        categories=categories,
                        tags=["niche", "workshop", "openreview"],
                        source_type="conference",
                        evidence_url=f"https://openreview.net/group?id={v}",
                    )
                    candidates.append(cand)
                    self.known_keys.add(cand_key)
        except Exception:
            pass
        return candidates

    def run_discovery(self, categories: list[str] | None = None, min_year: int = 2026) -> list[DiscoveredCandidate]:
        """Run full autonomous discovery across multiple sources."""
        results: list[DiscoveredCandidate] = []

        # 1. DBLP queries
        queries = ["workshop", "symposium", "journal", "systems", "hpc", "networking", "security"]
        for q in queries:
            results.extend(self.discover_from_dblp(q, max_results=20))

        # 2. OpenReview queries
        or_queries = ["workshop", "symposium", "workshop 2026"]
        for q in or_queries:
            results.extend(self.discover_from_openreview(q))

        # 3. wikiCFP: 各 cfp-radar カテゴリの代表カテゴリ 1 つずつ取得
        # ponytail: 代表 1 カテゴリのみ。全カテゴリ(約40)を舐めると低品質の
        # predatory 会議が大量に入る。候補が枯れたら増やす。
        for cat, wikicfp_cats in WIKICFP_CATEGORY_MAP.items():
            if categories and cat not in categories:
                continue
            for entry in discover_from_wikicfp_urls(wikicfp_cats[:1], min_year):
                cand_key = entry["key"]
                if self.is_already_tracked(cand_key) or self.is_already_tracked(entry["full_name"]):
                    continue
                cand = DiscoveredCandidate(
                    key=cand_key,
                    title=entry["title"],
                    full_name=entry["full_name"],
                    link=entry["link"],
                    categories=entry["categories"],
                    tags=["niche", "wikicfp"],
                    source_type="journal" if any(w in entry["full_name"].lower() for w in ("journal", "transactions", "letters")) else "conference",
                    evidence_url="https://www.wikicfp.com",
                    date_text=entry["date_text"],
                    place=entry["place"],
                )
                results.append(cand)
                self.known_keys.add(cand_key)

        # 4. Known niche candidate registry (fallback / curated candidates)
        curated_candidates = [
            DiscoveredCandidate(
                key="resound",
                title="RESOUND",
                full_name="International Workshop on Resilient Systems and Dependable Operating Systems",
                link="https://www.resound-workshop.org/",
                categories=["systems", "security"],
                tags=["niche", "workshop"],
                place="Europe",
                date_text="September 14, 2026",
            ),
            DiscoveredCandidate(
                key="netpl",
                title="NetPL",
                full_name="Workshop on Networking and Programming Languages",
                link="https://netpl.github.io/",
                categories=["networking", "systems"],
                tags=["niche", "workshop"],
                place="Virtual",
                date_text="October 10, 2026",
            ),
            DiscoveredCandidate(
                key="taco-special",
                title="ACM TACO Special Issues",
                full_name="ACM Transactions on Architecture and Code Optimization Special Call for Papers",
                link="https://dl.acm.org/journal/taco",
                categories=["systems", "hpc"],
                tags=["niche", "journal"],
                source_type="journal",
            ),
        ]

        for cand in curated_candidates:
            if not self.is_already_tracked(cand.key) and not self.is_already_tracked(cand.title):
                results.append(cand)
                self.known_keys.add(cand.key)

        # Filter by requested categories if specified
        if categories:
            results = [c for c in results if any(cat in categories for cat in c.categories)]

        return results


def format_discovered_yaml(candidates: list[DiscoveredCandidate]) -> str:
    """Format discovered candidates into YAML string compatible with extra.yaml."""
    data = {
        "conferences": [c.to_yaml_dict() for c in candidates]
    }
    return yaml.dump(data, allow_unicode=True, sort_keys=False)

