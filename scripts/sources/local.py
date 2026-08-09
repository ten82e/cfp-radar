"""Local source: conferences the upstreams do not carry (data/extra.yaml)."""

from __future__ import annotations

from datetime import date
from pathlib import Path

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

NAME = "local"
DEFAULT_PATH = Path(__file__).resolve().parents[2] / "data" / "extra.yaml"


def _as_date(value) -> date | None:
    if value is None:
        return None
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value).strip())
    except ValueError:
        return None


def _deadlines_of(raw: dict) -> list[Deadline]:
    out: list[Deadline] = []
    for entry in raw.get("deadlines") or []:
        if not isinstance(entry, dict):
            continue
        tz_raw = str(entry.get("tz") or entry.get("timezone") or "")
        at = parse_instant(entry.get("date"), tz_raw)
        if at is None:
            continue
        kind = kind_of(entry.get("kind") or entry.get("type") or "")
        label = str(entry.get("label") or kind)
        out.append(
            Deadline(
                kind=kind,
                label=label,
                at_utc=at,
                tz_raw=tz_raw,
                # A round named in the label wins over the explicit field, so a
                # 'Round 2 …' label cannot disagree with what is published.
                round=round_of(label, int(entry.get("round") or 1)),
                comment=entry.get("comment"),
            )
        )
    return out


def _edition_of(raw: dict, key: str) -> Edition | None:
    try:
        year = int(raw["year"])
    except (KeyError, TypeError, ValueError):
        warn(f"local edition without a usable year under {key!r}")
        return None
    date_text = str(raw.get("date_text") or raw.get("date") or "")
    start = _as_date(raw.get("event_start") or raw.get("start"))
    end = _as_date(raw.get("event_end") or raw.get("end"))
    if start is None or end is None:
        parsed_start, parsed_end = parse_date_range(date_text, year)
        start = start or parsed_start
        end = end or parsed_end
    return Edition(
        year=year,
        edition_id=str(raw.get("id") or f"{key}{year % 100:02d}"),
        link=str(raw.get("link") or ""),
        place=str(raw.get("place") or ""),
        date_text=date_text,
        event_start=start,
        event_end=end,
        deadlines=_deadlines_of(raw),
        source=NAME,
    )


def parse_file(path: Path) -> list[Conference]:
    """Read data/extra.yaml.  A missing file yields an empty list."""
    path = Path(path)
    if not path.exists():
        warn(f"local source: {path} not found; skipping")
        return []
    try:
        loaded = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as exc:
        warn(f"local source: cannot parse {path}: {exc}")
        return []

    out: list[Conference] = []
    for raw in loaded.get("conferences") or []:
        if not isinstance(raw, dict):
            continue
        title = str(raw.get("title") or "").strip()
        key = str(raw.get("key") or slug(title))
        if not key:
            warn(f"local source: entry without key or title in {path}")
            continue
        editions = [
            e
            for e in (_edition_of(c, key) for c in (raw.get("editions") or []))
            if e
        ]
        editions.sort(key=lambda e: e.year)
        rank = {
            str(k).lower(): str(v) for k, v in (raw.get("rank") or {}).items()
        }
        out.append(
            Conference(
                key=key,
                title=title or key,
                full_name=str(raw.get("full_name") or title or key),
                link=str(raw.get("link") or ""),
                rank=rank,
                dblp=raw.get("dblp"),
                tags=[str(t) for t in (raw.get("tags") or [])],
                categories=[str(c) for c in (raw.get("categories") or [])],
                editions=editions,
                sources=[NAME],
            )
        )
    return out


class LocalSource:
    name = NAME

    def __init__(self, path: Path | None = None) -> None:
        self.path = Path(path) if path else DEFAULT_PATH

    def load(
        self, cache_dir: Path, *, offline: bool = False
    ) -> list[Conference]:
        return parse_file(self.path)
