"""resolve_tz: SPEC.md section 3 + the timezone values listed in sections 1.1 / 1.2."""

from __future__ import annotations

import warnings
from datetime import datetime, timedelta

import pytest

WINTER = datetime(2026, 1, 15, 12, 0, 0)
SUMMER = datetime(2026, 7, 15, 12, 0, 0)


def offset(tz, when=WINTER) -> timedelta:
    return tz.utcoffset(when)


def test_aoe_is_utc_minus_12():
    from scripts.model import resolve_tz

    assert offset(resolve_tz("AoE")) == timedelta(hours=-12)
    assert offset(resolve_tz("aoe")) == timedelta(hours=-12)
    assert offset(resolve_tz("AOE")) == timedelta(hours=-12)


def test_module_constant_aoe_matches_resolver():
    from scripts.model import AOE, resolve_tz

    assert AOE.utcoffset(WINTER) == timedelta(hours=-12)
    assert offset(resolve_tz("AoE")) == AOE.utcoffset(WINTER)


@pytest.mark.parametrize("raw", ["UTC", "GMT", "utc", "", None])
def test_utc_like_values(raw):
    from scripts.model import resolve_tz

    assert offset(resolve_tz(raw)) == timedelta(0)


@pytest.mark.parametrize(
    "raw,hours",
    [
        ("UTC+0", 0),
        ("UTC-0", 0),
        ("UTC+1", 1),
        ("UTC+2", 2),
        ("UTC+3", 3),
        ("UTC+7", 7),
        ("UTC+8", 8),
        ("UTC+9", 9),
        ("UTC+10", 10),
        ("UTC-4", -4),
        ("UTC-5", -5),
        ("UTC-6", -6),
        ("UTC-7", -7),
        ("UTC-8", -8),
        ("UTC-10", -10),
        ("UTC-11", -11),
        ("UTC-12", -12),
        ("UTC-08", -8),
        ("UTC+02", 2),
        ("GMT+02", 2),
    ],
)
def test_fixed_offsets(raw, hours):
    from scripts.model import resolve_tz

    assert offset(resolve_tz(raw)) == timedelta(hours=hours)


def test_zero_padded_and_bare_offsets_agree():
    from scripts.model import resolve_tz

    assert offset(resolve_tz("UTC-08")) == offset(resolve_tz("UTC-8"))
    assert offset(resolve_tz("UTC+02")) == offset(resolve_tz("UTC+2"))


def test_colon_offset():
    from scripts.model import resolve_tz

    assert offset(resolve_tz("UTC+05:30")) == timedelta(hours=5, minutes=30)
    assert offset(resolve_tz("UTC-03:30")) == timedelta(hours=-3, minutes=-30)


@pytest.mark.parametrize("raw", ["PT", "PST", "PDT"])
def test_pacific_aliases_observe_dst(raw):
    """A DST-carrying zone must yield different offsets in winter and summer."""
    from scripts.model import resolve_tz

    tz = resolve_tz(raw)
    assert offset(tz, WINTER) == timedelta(hours=-8)
    assert offset(tz, SUMMER) == timedelta(hours=-7)
    assert offset(tz, WINTER) != offset(tz, SUMMER)


@pytest.mark.parametrize("raw", ["EST", "ET"])
def test_eastern_aliases(raw):
    from scripts.model import resolve_tz

    tz = resolve_tz(raw)
    assert offset(tz, WINTER) == timedelta(hours=-5)
    assert offset(tz, SUMMER) == timedelta(hours=-4)


def test_cet_alias():
    from scripts.model import resolve_tz

    tz = resolve_tz("CET")
    assert offset(tz, WINTER) == timedelta(hours=1)
    assert offset(tz, SUMMER) == timedelta(hours=2)


def test_iana_names():
    from scripts.model import resolve_tz

    london = resolve_tz("Europe/London")
    assert offset(london, WINTER) == timedelta(0)
    assert offset(london, SUMMER) == timedelta(hours=1)

    honolulu = resolve_tz("Pacific/Honolulu")
    assert offset(honolulu, WINTER) == timedelta(hours=-10)
    assert offset(honolulu, SUMMER) == timedelta(hours=-10)


def _resolve_capturing_warnings(capsys, raw, times=1):
    """Return (tz, report_count). A warning may go to `warnings` or to stderr."""
    from scripts.model import resolve_tz

    capsys.readouterr()
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        tz = None
        for _ in range(times):
            tz = resolve_tz(raw)
    captured = capsys.readouterr()
    stderr_lines = [ln for ln in captured.err.splitlines() if ln.strip()]
    return tz, len(caught) + len(stderr_lines)


def test_unknown_value_falls_back_to_utc_with_warning(capsys):
    tz, reports = _resolve_capturing_warnings(capsys, "Mars/Olympus_Mons")
    assert offset(tz) == timedelta(0)
    assert reports >= 1, "an unknown timezone must be reported, not silently ignored"


def test_unknown_value_does_not_raise_and_is_not_reported_repeatedly(capsys):
    tz, reports = _resolve_capturing_warnings(capsys, "Totally/Bogus_Zone", times=5)
    assert offset(tz) == timedelta(0)
    assert reports <= 2, "unknown timezone should be reported once, not per call"


ALL_UPSTREAM_TZ_VALUES = [
    # ccfddl (SPEC.md 1.1)
    "AoE", "UTC-12", "UTC-8", "UTC+0", "UTC", "UTC-7", "UTC-5", "UTC-4",
    "UTC+8", "UTC+1", "UTC+2", "UTC+3", "UTC+7", "UTC+9", "UTC+10", "UTC-6",
    "UTC-10", "UTC-11", "PT",
    # huggingface/ai-deadlines (SPEC.md 1.2)
    "UTC-08", "UTC+02", "GMT+02", "PST", "Europe/London", "Pacific/Honolulu",
]


@pytest.mark.parametrize("raw", ALL_UPSTREAM_TZ_VALUES)
def test_every_upstream_value_resolves(raw):
    from scripts.model import resolve_tz

    tz = resolve_tz(raw)
    assert tz.utcoffset(WINTER) is not None
    assert datetime(2026, 3, 1, 9, 0, tzinfo=tz).utcoffset() is not None
