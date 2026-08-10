"""Autonomous Discovery Engine for Niche Conferences & Journals.

This module searches external academic CFP sources (DBLP, WikiCFP, OpenReview,
Call4Paper, IEEE/ACM CFP lists) for niche conferences, workshops, symposia,
and journal Call for Papers in HPC, Systems, Networking, AI, and Security.
"""

from __future__ import annotations

import datetime
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
    "hpc": ["parallel", "high", "grid", "performance", "computational"],
    "networking": ["networks", "networking", "communications", "internet", "wireless",
                   "network", "telecommunications", "mobile", "ubiquitous", "pervasive", "sensor"],
    "systems": ["systems", "architecture", "operating", "distributed", "embedded", "cloud", "edge",
                "compilers", "programming", "software", "dependability", "reliability", "blockchain",
                "cyber-physical", "safety"],
    "ai": ["artificial", "machine", "deep", "neural", "intelligent",
           "cognitive", "fuzzy", "evolutionary", "robotics", "agents", "multi-agent", "pattern"],
    "security": ["security", "cybersecurity", "privacy", "cryptography", "cyber", "trust"],
    "db": ["database", "databases", "data", "big", "knowledge", "semantic", "semantics",
           "ontologies", "ontology"],
    "graphics": ["graphics", "multimedia", "visualization", "image", "virtual"],
    "hci": ["human", "human-computer"],
    "theory": ["theory", "algorithms", "theoretical", "complexity", "formal", "verification",
               "logic", "optimization", "graph"],
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
    for i, row in enumerate(rows):
        m = re.search(r'<a href="([^"]*event\.showcfp[^"]*)">([^<]+)</a>', row)
        if not m:
            continue
        href, title = m.group(1), html_mod.unescape(m.group(2)).strip()
        href = html_mod.unescape(href)
        # full name = イベント行の 2 番目の td
        tds = re.findall(r"<td[^>]*>(.*?)</td>", row, re.S)
        full_name = ""
        for td in tds[1:]:
            txt = re.sub(r"<[^>]+>", " ", td)
            txt = re.sub(r"\s+", " ", txt).strip()
            if txt and "checkbox" not in txt:
                full_name = txt
                break
        if not full_name or i + 1 >= len(rows):
            continue
        # ディテール行: when / where / deadline
        cells = [re.sub(r"<[^>]+>", " ", c) for c in re.findall(r"<td[^>]*>(.*?)</td>", rows[i + 1], re.S)]
        cells = [re.sub(r"\s+", " ", c).strip() for c in cells if re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", c)).strip()]
        if len(cells) < 3:
            continue
        when, where, deadline = cells[:3]
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
            "link": "https://www.wikicfp.com" + href,
            "categories": list(categories),
            "date_text": deadline,
            "place": where if where not in ("", "N/A") else "",
            "year": year,
        })
    return entries


def _deadline_is_future(date_text: str, today: datetime.date) -> bool:
    """'Aug 15, 2026 (Aug 1, 2026)' 形式の締切が今日以降か判定する。"""
    import re
    months = {m: i + 1 for i, m in enumerate(
        ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"])}
    m = re.search(r"([A-Z][a-z]{2})\s+(\d{1,2}),?\s*(20\d\d)?", date_text)
    if not m or m.group(1) not in months:
        return False  # 形式不明は候補にしない(裏取り原則)
    year = int(m.group(3)) if m.group(3) else today.year
    d = datetime.date(year, months[m.group(1)], int(m.group(2)))
    return d >= today


def discover_from_wikicfp_urls(categories: list[str], min_year: int) -> list[dict]:
    """wikiCFP カテゴリページを取得してパースする(ネットワーク層)。

    ページは締切昇順なので、未来締切が現れなくなるまで最大 3 ページ見る。
    """
    import datetime as dt
    import time

    entries: list[dict] = []
    today = dt.date.today()
    for cat in categories:
        for page in range(1, 4):
            url = f"http://www.wikicfp.com/cfp/call?conference={cat}&page={page}"
            try:
                time.sleep(0.4)  # リクエスト過多での一時ブロック回避
                req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (cfp-radar-discoverer)"})
                with urllib.request.urlopen(req, timeout=15) as resp:
                    html = resp.read().decode("utf-8", "replace")
                page_entries = parse_wikicfp_html(html, [cat], min_year)
            except Exception:
                # 1 カテゴリ 1 ページの失敗で全体を止めない
                break
            future = [e for e in page_entries if _deadline_is_future(e["date_text"], today)]
            entries.extend(future)
            if not future:
                break  # 締切昇順: ここから先はすべて過去締切
    return entries


def parse_dbworld_html(html: str) -> list[tuple[str, str]]:
    """DBWorld アーカイブ (dbworld.sigmod.org/browse.html) のメッセージ一覧から
    CFP 関連の (subject, アーカイブ URL) を返す。購読不要の public アーカイブ。"""
    import html as h
    import re

    out: list[tuple[str, str]] = []
    for row in re.findall(r"<TR VALIGN=TOP>.*?</TR>", html, re.S):
        m = re.search(r"<A HREF=([^>]+)>([^<]+)</A>", row)
        if not m:
            continue
        href = m.group(1).strip()
        subject = h.unescape(m.group(2)).strip()
        if re.search(r"call for (papers?|participation)|deadline|reminder|last call|special issue",
                     subject, re.I):
            out.append((subject, href))
    return out


def clean_dbworld_title(subject: str) -> tuple[str, str]:
    """DBWorld subject から会議名を抽出し、(会議名, source_type) を返す。

    例: "[DEADLINE EXTENDED] AI4DEMONS 2026@CIKM2026" -> ("AI4DEMONS 2026@CIKM2026", ...)
        "PDP 2027  Call for Papers & Call for Special Sessions" -> ("PDP 2027", ...)
        "iiWAS 2026 || Submission Deadline: 1 August 2026 (Final) || Bangkok" -> ("iiWAS 2026", ...)
    """
    import re

    t = subject.strip()
    t = re.sub(r"^(\[[^\]]*\]\s*)+", "", t)                    # [DEADLINE EXTENDED] 等 (複数)
    t = re.sub(r"^(?:Last\s+)?(?:Call for Papers?|CfP|CFP)\s*:?\s*", "", t, flags=re.I)
    t = re.sub(r"^(?:DEADLINE EXTENSION|Extended (?:Submission )?Deadline|Deadline\s+(?:Extended|Extension|Approaching))\s*:?\s*", "", t, flags=re.I)
    t = re.sub(r"\s*(?:[|:]\s*)?(?:Final\s+|Last\s+)?Call for\b.*$", "", t, flags=re.I)
    t = re.sub(r"\s*\|\|?.*$", "", t)                          # "|" 区切り以降
    t = re.sub(r"\s*:\s*[^()]*\bDeadline\b.*$", "", t, flags=re.I)  # 括弧外 ": ... Deadline ..."
    t = re.sub(r"\s*[-–]\s*(?:Deadline|Extended\s+deadline).*$", "", t, flags=re.I)
    t = re.sub(r"\s+", " ", t).strip(" -:|–")
    if len(t) < 4:
        return "", "conference"
    source_type = "journal" if re.search(r"special issue|transactions|journal", subject, re.I) else "conference"
    return t, source_type


def discover_from_dbworld(min_year: int) -> list[dict]:
    """DBWorld メーリス public アーカイブから CFP 候補を抽出する。"""
    import re

    url = "https://dbworld.sigmod.org/browse.html"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (cfp-radar-discoverer)"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        html = resp.read().decode("utf-8", "replace")

    entries: list[dict] = []
    for subject, href in parse_dbworld_html(html):
        cleaned, source_type = clean_dbworld_title(subject)
        if not cleaned:
            continue
        m = re.search(r"(20\d\d)", cleaned)
        year = int(m.group(1)) if m else min_year
        if year < min_year:
            continue
        entries.append({
            "key": slug(cleaned),
            "title": cleaned,
            "full_name": cleaned,
            "link": href,
            "categories": [],  # タイトルからの自動判定は誤爆が多い。レビュー時付与
            "source_type": source_type,
            "date_text": "",
            "place": "",
            "year": year,
        })
    return entries


def parse_easychair_cfp_html(html: str) -> list[dict]:
    """EasyChair Smart CFP 一覧 (easychair.org/cfp/) のテーブル行をパースする。

    列: Acronym | Name | Location | Submission Deadline | Start Date | Topics
    """
    import html as h
    import re

    out: list[dict] = []
    for tbody in re.findall(r"<tbody>(.*?)</tbody>", html, re.S):
        for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", tbody, re.S):
            cells = re.findall(r"<td[^>]*>(.*?)</td>", tr, re.S)
            if len(cells) < 5:
                continue
            m = re.search(r'href="(/cfp/[^"]+)"[^>]*>([^<]+)<', cells[0])
            if not m:
                continue
            text = lambda c: h.unescape(re.sub(r"<[^>]+>", "", c)).strip()
            topics = [h.unescape(t).strip() for t in re.findall(r'<span class="tag[^"]*">([^<]+)</span>', cells[5])] if len(cells) > 5 else []
            out.append({
                "title": h.unescape(m.group(2)).strip(),
                "full_name": text(cells[1]) or h.unescape(m.group(2)).strip(),
                "place": text(cells[2]),
                "date_text": text(cells[3]),
                "start": text(cells[4]),
                "topics": topics,
                "url": "https://easychair.org" + m.group(1),
            })
    return out


def _in_domain(text: str) -> bool:
    """EasyChair 候補がユーザー分野 (hpc/networking/systems/ai/security/db) に
    属するか簡易判定する。単語ベースで誤検知は許容 (レビューで捨てる)。"""
    t = " " + text.lower() + " "
    return any(k in t for k in (
        "network", "wireless", "communication", "telecom", "internet", "mobile", "iot",
        "system", "distributed", "cloud", "edge", "embedded", "operating", "architecture",
        "storage", "virtualization", "compiler", "hpc", "supercomputing", "parallel",
        "cluster", "grid", "computational", "performance", "security", "cyber", "privacy",
        "cryptograph", "cryptolog", "trust", "database", "data ", "knowledge", "semantic",
        "ontolog", "intelligent", "artificial intelligence", "machine learning",
        "deep learning", "llm", "nlp", "vision", " ai ", "robotics", "automation",
    ))


def discover_from_easychair(min_year: int) -> list[dict]:
    """EasyChair Smart CFP 一覧から締切登録済みの候補を抽出する。

    EasyChair は全分野の CFP が混在するため、ユーザー分野 (hpc/networking/
    systems/ai/security/db) にマッチするものだけ返す。
    """
    import re

    url = "https://easychair.org/cfp/"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (cfp-radar-discoverer)"})
    with urllib.request.urlopen(req, timeout=25) as resp:
        html = resp.read().decode("utf-8", "replace")
    entries = []
    for e in parse_easychair_cfp_html(html):
        if not e["date_text"]:
            continue  # 締切未登録は候補にしない
        dm = re.search(r"(20\d\d)", e["date_text"])
        if dm and int(dm.group(1)) < min_year:
            continue  # 過去締切
        m = re.search(r"20\d\d", e["title"] + " " + e["full_name"])
        year = int(m.group()) if m else min_year
        if year < min_year:
            continue
        if not _in_domain(e["title"] + " " + e["full_name"] + " " + " ".join(e["topics"])):
            continue
        entries.append({
            "key": slug(e["title"]),
            "title": e["title"],
            "full_name": e["full_name"],
            "link": e["url"],
            "categories": [],  # レビュー時付与
            "source_type": "conference",
            "date_text": e["date_text"],
            "place": e["place"],
            "year": year,
        })
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
        import re

        s = slug(key_or_title)
        if s in self.known_keys:
            return True
        if key_or_title.lower() in self.known_titles:
            return True
        # 年付きタイトル (例: "CIDR 2027") は年を除いて比較
        s_yearless = re.sub(r"\b20\d\d\b", "", s).strip("-")
        if s_yearless and s_yearless in self.known_keys:
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

        # 3. wikiCFP: 各 cfp-radar カテゴリの wikiCFP カテゴリ全部を取得。
        # 2026-08-10 に代表 1 カテゴリ → 全カテゴリ(70)に拡大。締切昇順ページング
        # で未来締切が途切れたら打ち切るため実 fetch 数は限られる。
        # 低品質 (predatory) 候補の混入は人間レビュー工程で捨てる想定。
        for cat, wikicfp_cats in WIKICFP_CATEGORY_MAP.items():
            if categories and cat not in categories:
                continue
            for entry in discover_from_wikicfp_urls(wikicfp_cats, min_year):
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

        # 4. DBWorld: メーリス public アーカイブ (購読不要)。wikiCFP に無い
        # 併設 WS・特集号・延長通知を拾う。DB 系中心だが S/N は高い。
        try:
            for entry in discover_from_dbworld(min_year):
                cand_key = entry["key"]
                if self.is_already_tracked(cand_key) or self.is_already_tracked(entry["full_name"]):
                    continue
                cand = DiscoveredCandidate(
                    key=cand_key,
                    title=entry["title"],
                    full_name=entry["full_name"],
                    link=entry["link"],
                    categories=entry["categories"],
                    tags=["niche", "dbworld"],
                    source_type=entry["source_type"],
                    evidence_url="https://dbworld.sigmod.org/browse.html",
                    date_text=entry["date_text"],
                    place=entry["place"],
                )
                results.append(cand)
                self.known_keys.add(cand_key)
        except Exception:
            pass  # アーカイブ障害で全体を止めない

        # 5. EasyChair Smart CFP: 運営者が登録した構造化 CFP (締切・場所・トピック)。
        # wikiCFP と同系統だが独立の登録母集団なので重複率は低い。
        try:
            for entry in discover_from_easychair(min_year):
                cand_key = entry["key"]
                if self.is_already_tracked(cand_key) or self.is_already_tracked(entry["full_name"]):
                    continue
                cand = DiscoveredCandidate(
                    key=cand_key,
                    title=entry["title"],
                    full_name=entry["full_name"],
                    link=entry["link"],
                    categories=entry["categories"],
                    tags=["niche", "easychair"],
                    source_type=entry["source_type"],
                    evidence_url="https://easychair.org/cfp/",
                    date_text=entry["date_text"],
                    place=entry["place"],
                )
                results.append(cand)
                self.known_keys.add(cand_key)
        except Exception:
            pass  # 一覧取得失敗で全体を止めない

        # 6. Known niche candidate registry (fallback / curated candidates)
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

