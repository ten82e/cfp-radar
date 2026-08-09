"""Core types, timezone resolution and date parsers.

This module is the single place where upstream free-form values are turned into
structured data.  Nothing here raises on bad input: unparsable values become
``None`` and a de-duplicated warning is written to stderr.
"""

from __future__ import annotations

import re
import sys
from calendar import monthrange
from collections import Counter
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone, tzinfo
from zoneinfo import ZoneInfo

UTC = timezone.utc
AOE = timezone(timedelta(hours=-12))  # Anywhere on Earth

DeadlineKind = str  # 'abstract'|'paper'|'supplementary'|'notification'|'camera_ready'
#                     |'rebuttal_start'|'rebuttal_end'|'review_release'
#                     |'registration'|'other'

KINDS = (
    "abstract",
    "paper",
    "supplementary",
    "notification",
    "camera_ready",
    "rebuttal_start",
    "rebuttal_end",
    "review_release",
    "registration",
    "other",
)


# --------------------------------------------------------------------------
# warnings (aggregated; each distinct message is printed once)
# --------------------------------------------------------------------------

_WARNINGS: Counter = Counter()


def warn(message: str) -> None:
    """Record a warning.  The first occurrence of a message goes to stderr."""
    _WARNINGS[message] += 1
    if _WARNINGS[message] == 1:
        print(f"warning: {message}", file=sys.stderr)


def warning_counts() -> dict[str, int]:
    return dict(_WARNINGS)


def reset_warnings() -> None:
    _WARNINGS.clear()


# --------------------------------------------------------------------------
# types
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Deadline:
    kind: DeadlineKind
    label: str
    at_utc: datetime  # tz-aware, UTC
    tz_raw: str
    round: int = 1
    comment: str | None = None


@dataclass
class Edition:
    year: int
    edition_id: str
    link: str
    place: str
    date_text: str
    event_start: date | None
    event_end: date | None
    deadlines: list[Deadline] = field(default_factory=list)
    estimated: bool = False
    source: str = ""


@dataclass
class Conference:
    key: str
    title: str
    full_name: str
    link: str
    rank: dict[str, str] = field(default_factory=dict)
    dblp: str | None = None
    upstream_sub: str | None = None
    tags: list[str] = field(default_factory=list)
    categories: list[str] = field(default_factory=list)
    editions: list[Edition] = field(default_factory=list)
    sources: list[str] = field(default_factory=list)


# --------------------------------------------------------------------------
# snapshot restore (SPEC.md section 6: keep building when upstream is down)
# --------------------------------------------------------------------------


def conferences_from_json(payload: dict) -> list[Conference]:
    """Rebuild conferences from a ``data.json``-shaped payload.

    ``data/snapshot.json`` holds the *finished* pipeline output, so the result
    is fed straight to the builder: categories and ``estimated`` flags are
    already resolved and must not be recomputed.  ``dblp`` / ``upstream_sub``
    are not serialised because only classification reads them; every field the
    builder does read round-trips, so a snapshot build is byte-identical to the
    healthy one.
    """
    out: list[Conference] = []
    for raw in payload.get("conferences") or []:
        editions = []
        for ed in raw.get("editions") or []:
            deadlines = []
            for dl in ed.get("deadlines") or []:
                at = parse_instant(dl.get("utc"), "UTC")
                if at is None:
                    continue
                deadlines.append(
                    Deadline(
                        kind=str(dl.get("kind") or "other"),
                        label=str(dl.get("label") or ""),
                        at_utc=at,
                        tz_raw=str(dl.get("tz_raw") or ""),
                        round=int(dl.get("round") or 1),
                        comment=dl.get("comment"),
                    )
                )
            editions.append(
                Edition(
                    year=int(ed["year"]),
                    edition_id=str(ed.get("id") or ""),
                    link=str(ed.get("link") or ""),
                    place=str(ed.get("place") or ""),
                    date_text=str(ed.get("date_text") or ""),
                    event_start=_date_or_none(ed.get("event_start")),
                    event_end=_date_or_none(ed.get("event_end")),
                    deadlines=deadlines,
                    estimated=bool(ed.get("estimated")),
                    source=str(ed.get("source") or ""),
                )
            )
        out.append(
            Conference(
                key=str(raw.get("key") or ""),
                title=str(raw.get("title") or ""),
                full_name=str(raw.get("full_name") or ""),
                link=str(raw.get("link") or ""),
                rank={str(k): str(v) for k, v in (raw.get("rank") or {}).items()},
                tags=[str(t) for t in (raw.get("tags") or [])],
                categories=[str(c) for c in (raw.get("categories") or [])],
                editions=editions,
                sources=[str(s) for s in (raw.get("sources") or [])],
            )
        )
    return out


def _date_or_none(value) -> date | None:
    if not value:
        return None
    try:
        return date.fromisoformat(str(value))
    except ValueError:
        return None


# --------------------------------------------------------------------------
# slug
# --------------------------------------------------------------------------


def slug(title: str) -> str:
    """Normalize a conference title into a key: 'IH&MMSec' -> 'ih-mmsec'."""
    return re.sub(r"[^a-z0-9]+", "-", (title or "").lower()).strip("-")


# --------------------------------------------------------------------------
# timezone
# --------------------------------------------------------------------------

_TZ_FIXED = {
    "": UTC,
    "utc": UTC,
    "gmt": UTC,
    "ut": UTC,
    "z": UTC,
    "aoe": AOE,
}

_TZ_NAMED = {
    "pt": "America/Los_Angeles",
    "pst": "America/Los_Angeles",
    "pdt": "America/Los_Angeles",
    "et": "America/New_York",
    "est": "America/New_York",
    "edt": "America/New_York",
    "cet": "Europe/Paris",
    "cest": "Europe/Paris",
}

_TZ_OFFSET_RE = re.compile(r"^(?:utc|gmt)?\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$")


def resolve_tz(tz_raw: str | None) -> tzinfo:
    """Map an upstream timezone string to a tzinfo.  Unknown values -> UTC."""
    if tz_raw is None:
        return UTC
    raw = str(tz_raw).strip()
    low = raw.lower()

    if low in _TZ_FIXED:
        return _TZ_FIXED[low]
    if low in _TZ_NAMED:
        return ZoneInfo(_TZ_NAMED[low])

    m = _TZ_OFFSET_RE.match(low)
    if m:
        sign = -1 if m.group(1) == "-" else 1
        hours = int(m.group(2))
        minutes = int(m.group(3) or 0)
        return timezone(sign * timedelta(hours=hours, minutes=minutes))

    if "/" in raw:
        try:
            return ZoneInfo(raw)
        except Exception:
            warn(f"unknown IANA timezone {raw!r}; using UTC")
            return UTC

    warn(f"unknown timezone {raw!r}; using UTC")
    return UTC


# --------------------------------------------------------------------------
# instants
# --------------------------------------------------------------------------

_DT_FORMATS = ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d")


def parse_instant(text: str, tz_raw: str | None) -> datetime | None:
    """Parse an upstream deadline into an aware UTC datetime, or None."""
    if text is None:
        return None

    if isinstance(text, datetime):
        if text.tzinfo is not None:
            return text.astimezone(UTC)
        naive = text
    elif isinstance(text, date):
        naive = datetime(text.year, text.month, text.day, 23, 59, 59)
    else:
        s = str(text).strip().replace("T", " ").strip()
        if s.endswith("Z"):
            s = s[:-1].strip()
        naive = None
        for fmt in _DT_FORMATS:
            try:
                naive = datetime.strptime(s, fmt)
            except ValueError:
                continue
            if fmt == "%Y-%m-%d":
                naive = naive.replace(hour=23, minute=59, second=59)
            break
        if naive is None:
            warn(f"unparsable deadline {str(text)!r}")
            return None

    return naive.replace(tzinfo=resolve_tz(tz_raw)).astimezone(UTC)


# --------------------------------------------------------------------------
# date ranges
# --------------------------------------------------------------------------

_MONTHS = (
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
)

_TOKEN_RE = re.compile(r"([A-Za-z]+)|(\d{1,4})")


def _month_of(word: str) -> int | None:
    w = word.lower()
    if len(w) < 3:
        return None
    for i, name in enumerate(_MONTHS, start=1):
        if name.startswith(w):
            return i
        # Upstream typos such as 'Septemper' (APWeb-WAIM 2024).  Match on the
        # first four letters once the token is long enough to be a month name.
        if len(w) >= 4 and name.startswith(w[:4]):
            return i
    return None


def _scan(part: str) -> tuple[int | None, int | None, int | None]:
    """Pull the first month / day / year out of one side of a range."""
    month = day = year = None
    for m in _TOKEN_RE.finditer(part):
        word, num = m.group(1), m.group(2)
        if word is not None:
            if month is None:
                month = _month_of(word)
        else:
            n = int(num)
            if len(num) == 4:
                if year is None:
                    year = n
            elif 1 <= n <= 31 and day is None:
                day = n
    return month, day, year


def _mkdate(year: int, month: int, day: int) -> date | None:
    try:
        return date(year, month, day)
    except ValueError:
        return None


def _month_span(year: int, month: int) -> tuple[date | None, date | None]:
    """First and last calendar day of ``month`` in ``year``."""
    try:
        last = monthrange(year, month)[1]
    except ValueError:
        return (None, None)
    return (_mkdate(year, month, 1), _mkdate(year, month, last))


def parse_date_range(
    text: str, fallback_year: int
) -> tuple[date | None, date | None]:
    """Parse free-form event dates such as 'September 29 - October 3, 2025'.

    Also accepts month-only forms that upstream really uses:

    * ``November, 2026`` (MobiCom 2026) → the whole calendar month
    * ``March-April, 2025`` (ASPLOS/EuroSys 2025) → first of March … last of April
    * ``August 2027 (exact dates TBD)`` → the month, parenthetical note stripped
    """
    if not text:
        return (None, None)

    s = re.sub(r"[\u2010-\u2015\u2212]", "-", str(text))
    s = re.sub(r"\s+", " ", s).strip()
    # Drop trailing notes that only say the day is unknown.
    s = re.sub(r"\s*\([^)]*\bTBD\b[^)]*\)\s*$", "", s, flags=re.IGNORECASE).strip()
    # 'September 29 to October 2, 2026' spells the range in words; without this
    # the second date is dropped and the range silently collapses to one day.
    s = re.sub(r"\s+(?:to|through|until)\s+", "-", s, flags=re.IGNORECASE)
    parts = s.split("-", 1)

    m1, d1, y1 = _scan(parts[0])
    if len(parts) == 1:
        if m1 is None:
            warn(f"unparsable event date {str(text)!r}")
            return (None, None)
        year = y1 or fallback_year
        if d1 is None:
            # Month-only: 'November, 2026' / 'Oct, 2022'.
            return _month_span(year, m1)
        one = _mkdate(year, m1, d1)
        return (one, one) if one else (None, None)

    m2, d2, y2 = _scan(parts[1])
    if m1 is None:
        m1 = m2
    if m2 is None:
        m2 = m1
    if m1 is None or m2 is None:
        warn(f"unparsable event date {str(text)!r}")
        return (None, None)

    # Month-only range: 'March-April, 2025' (no day numbers on either side).
    if d1 is None and d2 is None:
        if y1 is None and y2 is None:
            y1 = y2 = fallback_year
        elif y1 is None:
            y1 = y2 if y2 is not None else fallback_year
        elif y2 is None:
            y2 = (y1 + 1 if m2 < m1 else y1)
        assert y1 is not None and y2 is not None
        start, _ = _month_span(y1, m1)
        _, end = _month_span(y2, m2)
        if start is None or end is None or start > end:
            warn(f"unparsable event date {str(text)!r}")
            return (None, None)
        return (start, end)

    if d1 is None or d2 is None:
        warn(f"unparsable event date {str(text)!r}")
        return (None, None)

    if y1 is None and y2 is None:
        y1 = y2 = fallback_year
    elif y1 is None:
        y1 = y2 - 1 if m1 > m2 else y2
    elif y2 is None:
        y2 = y1 + 1 if m2 < m1 else y1

    start = _mkdate(y1, m1, d1)
    end = _mkdate(y2, m2, d2)
    if start is None or end is None or start > end:
        warn(f"unparsable event date {str(text)!r}")
        return (None, None)
    return (start, end)


# --------------------------------------------------------------------------
# deadline kinds
# --------------------------------------------------------------------------

# SPEC.md 3.3.  'deadline' is ccfddl's key for the main submission deadline
# (1591 rows upstream); dropping it empties the paper deadlines.
_PAPER = {"deadline", "paper", "submission", "full_paper"}
_CAMERA = {"camera_ready", "revision_deadline"}
# 'supplementary' stays separate (CVPR files body and supplement on different
# days) and so do the two rebuttal edges (AAAI opens and closes on different
# days).
_REBUTTAL_END = {"rebuttal_end", "rebuttal", "rebuttal_and_revision", "author_response"}
_REGISTRATION = {"registration", "reviewer_registration", "commitment_deadline"}


def kind_of(raw_type_or_key: str) -> DeadlineKind:
    """Normalize an upstream deadline type name into one of the 10 kinds."""
    s = re.sub(r"[\s\-]+", "_", str(raw_type_or_key or "").strip().lower())
    if s.startswith("abstract"):
        return "abstract"
    if "notification" in s:
        return "notification"
    if s in _PAPER:
        return "paper"
    if s == "supplementary":
        return "supplementary"
    if s in _CAMERA:
        return "camera_ready"
    if s == "rebuttal_start":
        return "rebuttal_start"
    if s in _REBUTTAL_END:
        return "rebuttal_end"
    if s == "review_release":
        return "review_release"
    if s in _REGISTRATION:
        return "registration"
    return "other"


# SPEC.md 3.3.  A free-form label that names its submission round ('Round 2
# Paper Submission', 'Paper Submission (Round 2) - Extended') carries round
# information that ai-deadlines has nowhere else to put: its schema has no round
# field, so without this the round is lost whenever the other upstream does not
# list the same deadline.  'Camera Ready Both Rounds' names no number and is
# left alone.
_ROUND_IN_LABEL = re.compile(r"\bround\s*([0-9]+)", re.IGNORECASE)


def round_of(label: str, default: int = 1) -> int:
    """Submission round stated in a free-form label, else ``default``."""
    match = _ROUND_IN_LABEL.search(str(label or ""))
    if match:
        value = int(match.group(1))
        if value >= 1:  # rounds are 1-based; 'Round 0' is not a round
            return value
    return default
