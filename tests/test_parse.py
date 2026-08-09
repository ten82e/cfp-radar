"""parse_instant / parse_date_range / slug: SPEC.md section 3."""

from __future__ import annotations

from datetime import date, datetime, timezone

import pytest

UTC = timezone.utc


def utc(y, mo, d, h=0, mi=0, s=0) -> datetime:
    return datetime(y, mo, d, h, mi, s, tzinfo=UTC)


# --- parse_instant ---------------------------------------------------------


def test_aoe_boundary_case():
    """SC26: '2026-04-08 23:59:00' AoE is 2026-04-09T11:59:00Z."""
    from scripts.model import parse_instant

    got = parse_instant("2026-04-08 23:59:00", "AoE")
    assert got == utc(2026, 4, 9, 11, 59, 0)


def test_result_is_timezone_aware_utc():
    from scripts.model import parse_instant

    got = parse_instant("2026-02-06 23:59:59", "AoE")
    assert got.tzinfo is not None
    assert got.utcoffset().total_seconds() == 0


def test_aoe_end_of_day_rolls_into_next_day():
    from scripts.model import parse_instant

    assert parse_instant("2026-02-06 23:59:59", "AoE") == utc(2026, 2, 7, 11, 59, 59)


def test_utc_input_is_unchanged():
    from scripts.model import parse_instant

    assert parse_instant("2025-01-31 23:59:59", "UTC") == utc(2025, 1, 31, 23, 59, 59)


def test_fixed_negative_offset():
    """NSDI 2022 round 1: '2021-03-04 20:59:59' at UTC-8."""
    from scripts.model import parse_instant

    assert parse_instant("2021-03-04 20:59:59", "UTC-8") == utc(2021, 3, 5, 4, 59, 59)


def test_positive_offset():
    from scripts.model import parse_instant

    assert parse_instant("2024-04-28 23:59:59", "UTC+8") == utc(2024, 4, 28, 15, 59, 59)


def test_dst_zone_winter_and_summer_differ():
    from scripts.model import parse_instant

    winter = parse_instant("2026-01-15 12:00:00", "PT")
    summer = parse_instant("2026-07-15 12:00:00", "PT")
    assert winter == utc(2026, 1, 15, 20, 0, 0)
    assert summer == utc(2026, 7, 15, 19, 0, 0)


def test_minute_precision_form():
    from scripts.model import parse_instant

    assert parse_instant("2026-04-08 23:59", "UTC") == utc(2026, 4, 8, 23, 59, 0)


def test_date_only_is_end_of_day():
    from scripts.model import parse_instant

    assert parse_instant("2026-04-08", "UTC") == utc(2026, 4, 8, 23, 59, 59)


def test_date_only_in_aoe():
    from scripts.model import parse_instant

    assert parse_instant("2026-04-08", "AoE") == utc(2026, 4, 9, 11, 59, 59)


@pytest.mark.parametrize("text", ["TBD", "tbd", "", "   ", "N/A", "to be announced"])
def test_unparseable_returns_none(text):
    from scripts.model import parse_instant

    assert parse_instant(text, "AoE") is None


def test_unparseable_does_not_raise_for_missing_timezone():
    from scripts.model import parse_instant

    assert parse_instant("TBD", None) is None


# --- parse_date_range ------------------------------------------------------


@pytest.mark.parametrize(
    "text,year,expected",
    [
        ("August 17 - 21, 2026", 2026, (date(2026, 8, 17), date(2026, 8, 21))),
        ("September 29 - October 3, 2025", 2025, (date(2025, 9, 29), date(2025, 10, 3))),
        ("June 28 - July 2, 2026", 2026, (date(2026, 6, 28), date(2026, 7, 2))),
        ("Oct 12-16, 2025", 2025, (date(2025, 10, 12), date(2025, 10, 16))),
        ("November 15, 2026", 2026, (date(2026, 11, 15), date(2026, 11, 15))),
        ("July 31-August 8, 2022", 2022, (date(2022, 7, 31), date(2022, 8, 8))),
        ("June 29-July 3, 2024", 2024, (date(2024, 6, 29), date(2024, 7, 3))),
        ("Jan 19 - Jan 24, 2025", 2025, (date(2025, 1, 19), date(2025, 1, 24))),
        ("May 4-6, 2026", 2026, (date(2026, 5, 4), date(2026, 5, 6))),
        (
            "November 30 - December 7, 2025",
            2025,
            (date(2025, 11, 30), date(2025, 12, 7)),
        ),
    ],
)
def test_date_ranges(text, year, expected):
    from scripts.model import parse_date_range

    assert parse_date_range(text, year) == expected


def test_year_crossing_prefers_explicit_years():
    from scripts.model import parse_date_range

    got = parse_date_range("December 28, 2025 - January 3, 2026", 2025)
    assert got == (date(2025, 12, 28), date(2026, 1, 3))


def test_fallback_year_used_when_text_has_none():
    from scripts.model import parse_date_range

    assert parse_date_range("August 17 - 21", 2026) == (
        date(2026, 8, 17),
        date(2026, 8, 21),
    )


@pytest.mark.parametrize("text", ["", "TBD", "Summer 2026", "to be determined"])
def test_unparseable_range_returns_none_pair(text):
    from scripts.model import parse_date_range

    assert parse_date_range(text, 2026) == (None, None)


def test_range_end_is_not_before_start():
    from scripts.model import parse_date_range

    start, end = parse_date_range("September 29 - October 3, 2025", 2025)
    assert start is not None and end is not None
    assert start <= end


def test_date_range_written_with_the_word_to():
    """hf's sibgrapi26 spells the range as 'September 29 to October 2, 2026'.

    Treating 'to' as text collapses the range to a single day without warning.
    """
    from datetime import date

    from scripts.model import parse_date_range

    assert parse_date_range("September 29 to October 2, 2026", 2026) == (
        date(2026, 9, 29),
        date(2026, 10, 2),
    )
    assert parse_date_range("August 17 to 21, 2026", 2026) == (
        date(2026, 8, 17),
        date(2026, 8, 21),
    )
    # the usual dash forms keep working
    assert parse_date_range("Oct 12-16, 2025", 2025) == (
        date(2025, 10, 12),
        date(2025, 10, 16),
    )


def test_month_only_spans_the_whole_month():
    """MobiCom 2026 upstream: 'November, 2026' (no day). Use the calendar month."""
    from scripts.model import parse_date_range

    assert parse_date_range("November, 2026", 2026) == (
        date(2026, 11, 1),
        date(2026, 11, 30),
    )
    assert parse_date_range("Oct, 2022", 2022) == (date(2022, 10, 1), date(2022, 10, 31))
    assert parse_date_range("September , 2022", 2022) == (
        date(2022, 9, 1),
        date(2022, 9, 30),
    )


def test_month_range_without_days():
    """ASPLOS 2025 / EuroSys 2025: 'March-April, 2025'."""
    from scripts.model import parse_date_range

    assert parse_date_range("March-April, 2025", 2025) == (
        date(2025, 3, 1),
        date(2025, 4, 30),
    )


def test_month_with_tbd_parenthetical():
    """SIGKDD 2027: 'August 2027 (exact dates TBD)'."""
    from scripts.model import parse_date_range

    assert parse_date_range("August 2027 (exact dates TBD)", 2027) == (
        date(2027, 8, 1),
        date(2027, 8, 31),
    )


def test_common_month_typo_septemper():
    """APWeb-WAIM 2024: 'August 30 - Septemper 1, 2024'."""
    from scripts.model import parse_date_range

    assert parse_date_range("August 30 - Septemper 1, 2024", 2024) == (
        date(2024, 8, 30),
        date(2024, 9, 1),
    )


# --- slug ------------------------------------------------------------------


@pytest.mark.parametrize(
    "title,expected",
    [
        ("SIGCOMM", "sigcomm"),
        ("Hot Interconnects", "hot-interconnects"),
        ("IH&MMSec", "ih-mmsec"),
        ("SC", "sc"),
        ("NeurIPS", "neurips"),
        ("  Leading and trailing  ", "leading-and-trailing"),
        ("A -- B", "a-b"),
    ],
)
def test_slug(title, expected):
    from scripts.model import slug

    assert slug(title) == expected


def test_slug_is_idempotent():
    from scripts.model import slug

    assert slug(slug("Hot Interconnects")) == slug("Hot Interconnects")


def test_aideadlines_lifts_stale_year_in_date_text():
    """UAI 2026 HF entry: date August 17-21, 2025 under year 2026."""
    from scripts.sources.aideadlines import _edition_of

    ed = _edition_of(
        {
            "year": 2026,
            "id": "uai26",
            "date": "August 17-21, 2025",
            "deadline": "2026-02-25 23:59:59",
            "timezone": "AoE",
            "city": "Amsterdam",
            "country": "Netherlands",
        }
    )
    assert ed is not None
    assert ed.event_start == date(2026, 8, 17)
    assert ed.event_end == date(2026, 8, 21)
    assert "2026" in ed.date_text


def test_aideadlines_prefers_date_text_when_start_year_disagrees():
    """ICASSP 2026 HF: start/end 2025-05-04..08 but date May 4-8, 2026."""
    from scripts.sources.aideadlines import _edition_of

    ed = _edition_of(
        {
            "year": 2026,
            "id": "icassp26",
            "date": "May 4-8, 2026",
            "start": "2025-05-04",
            "end": "2025-05-08",
            "deadlines": [
                {
                    "type": "submission",
                    "label": "Paper Submission",
                    "date": "2025-09-18 08:59:59",
                    "timezone": "GMT+02",
                }
            ],
        }
    )
    assert ed is not None
    assert ed.event_start == date(2026, 5, 4)
    assert ed.event_end == date(2026, 5, 8)


def test_warning_counts_tallies_unparsable_event_dates():
    """cli build prints a warning summary from this counter (R11)."""
    from scripts.model import parse_date_range, reset_warnings, warning_counts, warn

    reset_warnings()
    assert warning_counts() == {}
    parse_date_range("TBD", 2026)
    parse_date_range("TBD", 2026)
    warn("custom")
    counts = warning_counts()
    assert counts.get("unparsable event date 'TBD'") == 2
    assert counts.get("custom") == 1
    reset_warnings()
    assert warning_counts() == {}
