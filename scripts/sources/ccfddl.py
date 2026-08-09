"""ccfddl/ccf-deadlines source."""

from __future__ import annotations

from pathlib import Path

import yaml

from ..model import Conference, Deadline, Edition, parse_date_range, parse_instant, slug, warn
from .base import fetch_tarball

REPO = "ccfddl/ccf-deadlines"
REF = "main"
NAME = "ccfddl"

# 'abstract deadline' (with a space) exists once upstream.
_ABSTRACT_KEYS = ("abstract_deadline", "abstract deadline")


def _deadlines_of(timeline: list, tz_raw: str) -> list[Deadline]:
    out: list[Deadline] = []
    for index, entry in enumerate(timeline or []):
        if not isinstance(entry, dict):
            continue
        rnd = index + 1
        comment = entry.get("comment")
        raw_abstract = None
        for key in _ABSTRACT_KEYS:
            if entry.get(key) is not None:
                raw_abstract = entry[key]
                break
        for kind, label, raw in (
            ("abstract", "Abstract submission", raw_abstract),
            ("paper", "Paper submission", entry.get("deadline")),
        ):
            if raw is None:
                continue
            at = parse_instant(raw, tz_raw)
            if at is None:
                continue
            out.append(
                Deadline(
                    kind=kind,
                    label=label,
                    at_utc=at,
                    tz_raw=tz_raw,
                    round=rnd,
                    comment=comment,
                )
            )
    return out


def _edition_of(raw: dict) -> Edition | None:
    try:
        year = int(raw["year"])
    except (KeyError, TypeError, ValueError):
        warn(f"ccfddl edition without a usable year: {raw.get('id')!r}")
        return None
    tz_raw = str(raw.get("timezone") or "")
    date_text = str(raw.get("date") or "")
    start, end = parse_date_range(date_text, year)
    return Edition(
        year=year,
        edition_id=str(raw.get("id") or ""),
        link=str(raw.get("link") or ""),
        place=str(raw.get("place") or ""),
        date_text=date_text,
        event_start=start,
        event_end=end,
        deadlines=_deadlines_of(raw.get("timeline"), tz_raw),
        source=NAME,
    )


def _conference_of(raw: dict) -> Conference | None:
    title = str(raw.get("title") or "").strip()
    if not title:
        return None
    editions = [
        e for e in (_edition_of(c) for c in (raw.get("confs") or [])) if e
    ]
    editions.sort(key=lambda e: e.year)
    rank = {
        str(k).lower(): str(v)
        for k, v in (raw.get("rank") or {}).items()
        if v is not None
    }
    link = ""
    for edition in reversed(editions):
        if edition.link:
            link = edition.link
            break
    return Conference(
        key=slug(title),
        title=title,
        full_name=str(raw.get("description") or title),
        link=link,
        rank=rank,
        dblp=raw.get("dblp"),
        upstream_sub=raw.get("sub"),
        editions=editions,
        sources=[NAME],
    )


def parse_tree(conference_dir: Path) -> list[Conference]:
    """Read every ``conference/<SUB>/<name>.yml`` under an extracted tree."""
    out: list[Conference] = []
    for path in sorted(Path(conference_dir).rglob("*.yml")):
        if path.name == "types.yml":
            continue
        try:
            loaded = yaml.safe_load(path.read_text(encoding="utf-8"))
        except yaml.YAMLError as exc:
            warn(f"ccfddl: cannot parse {path.name}: {exc}")
            continue
        if isinstance(loaded, dict):
            loaded = [loaded]
        for raw in loaded or []:
            if not isinstance(raw, dict):
                continue
            conference = _conference_of(raw)
            if conference is not None:
                out.append(conference)
    return out


class CcfddlSource:
    name = NAME

    def load(
        self, cache_dir: Path, *, offline: bool = False
    ) -> list[Conference]:
        root = fetch_tarball(REPO, REF, cache_dir, offline=offline)
        return parse_tree(root / "conference")
