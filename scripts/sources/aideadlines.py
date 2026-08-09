"""huggingface/ai-deadlines source."""

from __future__ import annotations

from datetime import date
from pathlib import Path
import re

import yaml

from ..model import (
    Conference,
    Deadline,
    Edition,
    kind_of,
    parse_date_range,
    parse_instant,
    round_of,
    slug,
    warn,
)
from .base import fetch_tarball

REPO = "huggingface/ai-deadlines"
REF = "main"
NAME = "aideadlines"

# Old-format editions carry the deadlines at the top level.
_LEGACY = (
    ("abstract_deadline", "abstract", "Abstract submission"),
    ("deadline", "paper", "Paper submission"),
)


def _as_date(value) -> date | None:
    if value is None:
        return None
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value).strip())
    except ValueError:
        return None


def _lift_stale_year(date_text: str, year: int) -> str:
    """Rewrite a lone previous-year token in free text to the edition year.

    HF occasionally copies last year's month range under the new year label
    (UAI 2026: ``date: August 17-21, 2025``).  When every year in the string is
    exactly ``year - 1``, lift it; mixed years are left alone.
    """
    found = [int(token) for token in re.findall(r"\b(20\d{2})\b", date_text)]
    if found and set(found) == {year - 1}:
        return re.sub(rf"\b{year - 1}\b", str(year), date_text)
    return date_text


def _rank_of(rankings) -> dict[str, str]:
    """'CCF: A, CORE: A*, THCPL: A' -> {'ccf': 'A', 'core': 'A*', ...}."""
    rank: dict[str, str] = {}
    if not rankings:
        return rank
    for chunk in str(rankings).split(","):
        name, sep, value = chunk.partition(":")
        if sep and name.strip() and value.strip():
            rank[name.strip().lower()] = value.strip()
    return rank


def _deadlines_of(raw: dict) -> list[Deadline]:
    out: list[Deadline] = []
    entries = raw.get("deadlines")
    if isinstance(entries, list):
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            tz_raw = str(entry.get("timezone") or "")
            at = parse_instant(entry.get("date"), tz_raw)
            if at is None:
                continue
            raw_type = str(entry.get("type") or "")
            label = str(entry.get("label") or raw_type)
            out.append(
                Deadline(
                    kind=kind_of(raw_type),
                    label=label,
                    at_utc=at,
                    tz_raw=tz_raw,
                    # This schema has no round field; the label is the only
                    # place a round is ever stated (SPEC.md 3.3).
                    round=round_of(label),
                )
            )
        return out

    tz_raw = str(raw.get("timezone") or "")
    for key, kind, label in _LEGACY:
        at = parse_instant(raw.get(key), tz_raw)
        if at is not None:
            out.append(Deadline(kind=kind, label=label, at_utc=at, tz_raw=tz_raw))
    return out


def _edition_of(raw: dict) -> Edition | None:
    try:
        year = int(raw["year"])
    except (KeyError, TypeError, ValueError):
        warn(f"aideadlines edition without a usable year: {raw.get('id')!r}")
        return None
    date_text = _lift_stale_year(str(raw.get("date") or ""), year)
    start = _as_date(raw.get("start"))
    end = _as_date(raw.get("end"))
    parsed_start, parsed_end = parse_date_range(date_text, year)
    # Structured start/end is sometimes a full year off while the free-text
    # date names the edition year (ICASSP 2026: start 2025-05-04, date May 2026).
    if (
        parsed_start is not None
        and parsed_end is not None
        and parsed_start.year == year
        and (start is None or end is None or start.year != year)
    ):
        start, end = parsed_start, parsed_end
    else:
        start = start or parsed_start
        end = end or parsed_end
    place = ", ".join(
        str(raw[k]).strip() for k in ("city", "country") if raw.get(k)
    )
    return Edition(
        year=year,
        edition_id=str(raw.get("id") or ""),
        link=str(raw.get("link") or ""),
        place=place,
        date_text=date_text,
        event_start=start,
        event_end=end,
        deadlines=_deadlines_of(raw),
        source=NAME,
    )


def parse_tree(conferences_dir: Path) -> list[Conference]:
    """Read ``src/data/conferences/*.yml``; each item is one edition."""
    by_key: dict[str, Conference] = {}
    for path in sorted(Path(conferences_dir).glob("*.yml")):
        try:
            loaded = yaml.safe_load(path.read_text(encoding="utf-8"))
        except yaml.YAMLError as exc:
            warn(f"aideadlines: cannot parse {path.name}: {exc}")
            continue
        if isinstance(loaded, dict):
            loaded = [loaded]
        for raw in loaded or []:
            if not isinstance(raw, dict):
                continue
            title = str(raw.get("title") or "").strip()
            if not title:
                continue
            edition = _edition_of(raw)
            if edition is None:
                continue
            key = slug(title)
            conference = by_key.get(key)
            if conference is None:
                conference = Conference(
                    key=key,
                    title=title,
                    full_name=str(raw.get("full_name") or title),
                    link="",
                    tags=[str(t) for t in (raw.get("tags") or [])],
                    sources=[NAME],
                )
                by_key[key] = conference
            conference.editions.append(edition)
            # Conference-level facts come from the newest edition seen.
            if edition.year >= max(e.year for e in conference.editions):
                conference.full_name = str(raw.get("full_name") or title)
                conference.rank = _rank_of(raw.get("rankings")) or conference.rank
                conference.link = edition.link or conference.link
                conference.tags = [
                    str(t) for t in (raw.get("tags") or [])
                ] or conference.tags
    for conference in by_key.values():
        conference.editions.sort(key=lambda e: e.year)
    return [by_key[k] for k in sorted(by_key)]


class AideadlinesSource:
    name = NAME

    def load(
        self, cache_dir: Path, *, offline: bool = False
    ) -> list[Conference]:
        root = fetch_tarball(REPO, REF, cache_dir, offline=offline)
        return parse_tree(root / "src" / "data" / "conferences")
