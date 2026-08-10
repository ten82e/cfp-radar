"""ICS output requirements: SPEC.md section 4.1.

The generated calendars are re-read with the `icalendar` package rather than a
hand-written parser, per SPEC.md section 6.
"""

from __future__ import annotations

import copy
import re
from datetime import date, datetime, timedelta, timezone

import pytest

from .conftest import NOW, ics_physical_lines, unfold_ics, vevent_blocks

UTC = timezone.utc

# Long enough that folding is unavoidable, and multi-byte throughout so that a
# fold placed on a byte boundary instead of a character boundary corrupts it.
JP_COMMENT = (
    "投稿は査読付き本会議トラックのみで、"
    "テンプレート違反・書式逸脱・匿名化不備は机上却下となる。"
    "詳細は募集要項を参照のこと。"
)
TRICKY_PLACE = "Denver, Colorado, USA; 会場は大規模会議場 \\ 別館"
LINK = "https://conferences.sigcomm.org/sigcomm/2026/"

PAPER_AT = datetime(2026, 2, 7, 11, 59, 59, tzinfo=UTC)  # 2026-02-06 23:59:59 AoE


def _conferences(make_conf):
    sigcomm = make_conf.conference(
        key="sigcomm",
        title="SIGCOMM",
        full_name="ACM SIGCOMM Conference",
        link=LINK,
        rank={"ccf": "A", "core": "A*"},
        upstream_sub="NW",
        categories=["networking"],
        sources=["ccfddl"],
        editions=[
            make_conf.edition(
                year=2026,
                edition_id="sigcomm26",
                link=LINK,
                place=TRICKY_PLACE,
                date_text="August 17 - 21, 2026",
                event_start=date(2026, 8, 17),
                event_end=date(2026, 8, 21),
                deadlines=[
                    make_conf.deadline(
                        "abstract",
                        "Abstract registration",
                        datetime(2026, 1, 31, 11, 59, 59, tzinfo=UTC),
                        "AoE",
                    ),
                    make_conf.deadline(
                        "paper", "Paper submission", PAPER_AT, "AoE", comment=JP_COMMENT
                    ),
                ],
            ),
            make_conf.edition(
                year=2027,
                edition_id="sigcomm27",
                link=LINK,
                place="TBD",
                date_text="",
                estimated=True,
                deadlines=[
                    make_conf.deadline(
                        "paper",
                        "Paper submission (estimated)",
                        PAPER_AT + timedelta(days=364),
                        "AoE",
                    )
                ],
            ),
        ],
    )
    sc = make_conf.conference(
        key="sc",
        title="SC",
        full_name="International Conference for High Performance Computing",
        link="https://sc26.supercomputing.org/",
        rank={"ccf": "A", "core": "A"},
        upstream_sub="DS",
        categories=["hpc"],
        sources=["ccfddl"],
        editions=[
            make_conf.edition(
                year=2026,
                edition_id="sc26",
                link="https://sc26.supercomputing.org/",
                place="Chicago, Illinois, USA",
                date_text="November 15-20, 2026",
                event_start=date(2026, 11, 15),
                event_end=date(2026, 11, 20),
                deadlines=[
                    make_conf.deadline(
                        "paper",
                        "Paper submission",
                        datetime(2026, 4, 9, 11, 59, 0, tzinfo=UTC),
                        "AoE",
                    )
                ],
            )
        ],
    )
    return [sigcomm, sc]


@pytest.fixture
def built(tmp_path, make_conf, repo_config):
    from scripts.build import build_all

    outdir = tmp_path / "public"
    outdir.mkdir(parents=True, exist_ok=True)
    stats = build_all(_conferences(make_conf), copy.deepcopy(repo_config), outdir, NOW)
    assert isinstance(stats, dict)
    return outdir


def read(outdir, name) -> bytes:
    path = outdir / name
    assert path.exists(), f"{name} was not generated"
    return path.read_bytes()


def text_of(outdir, name) -> str:
    return read(outdir, name).decode("utf-8")


# --- line structure --------------------------------------------------------


def test_line_endings_are_crlf(built):
    raw = read(built, "all.ics")
    assert b"\r\n" in raw
    assert raw.replace(b"\r\n", b"").count(b"\n") == 0, "bare LF present"
    assert raw.replace(b"\r\n", b"").count(b"\r") == 0, "bare CR present"


def test_lines_are_folded_at_75_octets(built):
    lines = ics_physical_lines(read(built, "all.ics"))
    assert lines, "empty calendar"
    over = [ln for ln in lines if len(ln) > 75]
    assert not over, f"lines longer than 75 octets: {over[:3]}"
    continuations = [ln for ln in lines if ln.startswith(b" ") or ln.startswith(b"\t")]
    assert continuations, "nothing was folded; the folding path is untested"


def test_folding_does_not_split_utf8_characters(built):
    """Every physical line must decode on its own after folding."""
    for name in ("all.ics", "deadlines.ics", "networking.ics"):
        for i, line in enumerate(ics_physical_lines(read(built, name))):
            try:
                line.decode("utf-8")
            except UnicodeDecodeError as exc:
                pytest.fail(f"{name} line {i + 1} split a multi-byte character: {exc}")


def test_multibyte_content_survives_a_fold_unfold_roundtrip(built):
    lines = unfold_ics(text_of(built, "all.ics"))
    joined = "\n".join(lines)
    assert JP_COMMENT in joined, "Japanese text was corrupted by folding"


# --- escaping --------------------------------------------------------------


def _text_property_values(lines, name):
    out = []
    for line in lines:
        if line.startswith(name + ":"):
            out.append(line.split(":", 1)[1])
    return out


def test_colon_is_not_escaped(built):
    """Escaping ':' would break every URL in the feed."""
    lines = unfold_ics(text_of(built, "all.ics"))
    joined = "\n".join(lines)
    assert "\\:" not in joined
    urls = [ln for ln in lines if ln.startswith("URL:")]
    assert urls, "no URL property emitted"
    assert any(ln.startswith("URL:https://") for ln in urls)
    descriptions = _text_property_values(lines, "DESCRIPTION")
    assert any("https://" in d for d in descriptions), "link missing from DESCRIPTION"


def test_comma_semicolon_and_backslash_are_escaped(built):
    lines = unfold_ics(text_of(built, "all.ics"))
    descriptions = _text_property_values(lines, "DESCRIPTION")
    assert descriptions
    target = [d for d in descriptions if "Colorado" in d]
    assert target, "the place with special characters is not in any DESCRIPTION"
    value = target[0]
    assert "\\," in value
    assert "\\;" in value
    assert "\\\\" in value
    assert re.search(r"(?<!\\),", value) is None, "unescaped comma in TEXT value"
    assert re.search(r"(?<!\\);", value) is None, "unescaped semicolon in TEXT value"


def test_no_literal_newline_inside_text_values(built):
    for line in unfold_ics(text_of(built, "all.ics")):
        assert "\n" not in line
        assert "\r" not in line


# --- calendar level properties --------------------------------------------


def test_calendar_properties(built):
    body = text_of(built, "all.ics")
    lines = unfold_ics(body)
    assert lines[0] == "BEGIN:VCALENDAR"
    assert lines[-1] in ("END:VCALENDAR", "")
    assert "VERSION:2.0" in lines
    assert "CALSCALE:GREGORIAN" in lines
    assert "X-WR-TIMEZONE:UTC" in lines
    assert "REFRESH-INTERVAL;VALUE=DURATION:PT12H" in lines
    assert "X-PUBLISHED-TTL:PT12H" in lines
    assert "PRODID:-//conf-deadlines//conf-deadlines//EN" in lines


def test_method_is_not_emitted(built):
    """SPEC.md 4.1: METHOD would make DTSTAMP the freshness signal (RFC 5546
    2.1.5) and would require an ORGANIZER (RFC 5546 3.2); this feed has a fixed
    DTSTAMP and no organizer."""
    for name in ("all.ics", "deadlines.ics", "all-estimated.ics"):
        lines = unfold_ics(text_of(built, name))
        assert not [ln for ln in lines if ln.startswith("METHOD")], name
        assert not [ln for ln in lines if ln.startswith("SEQUENCE")], name
    assert any(ln.startswith("X-WR-CALNAME") for ln in lines)
    assert any(ln.startswith("X-WR-CALDESC") for ln in lines)


# --- events ----------------------------------------------------------------


def test_deadline_event_shape(built):
    from icalendar import Calendar

    cal = Calendar.from_ical(text_of(built, "deadlines.ics"))
    events = [c for c in cal.walk("VEVENT")]
    assert events

    target = [e for e in events if str(e["UID"]) == "sigcomm-2026-paper-1@conf-deadlines.github.io"]
    assert target, f"expected UID missing; got {[str(e['UID']) for e in events]}"
    ev = target[0]

    assert ev["DTEND"].dt == PAPER_AT
    assert ev["DTSTART"].dt == PAPER_AT - timedelta(minutes=30)
    assert "SIGCOMM" in str(ev["SUMMARY"])
    assert "2026" in str(ev["SUMMARY"])
    assert str(ev["URL"]) == LINK

    alarms = ev.walk("VALARM")
    assert len(alarms) == 3
    triggers = {a["TRIGGER"].dt for a in alarms}
    assert triggers == {
        timedelta(days=-7),
        timedelta(days=-1),
        timedelta(hours=-3),
    }
    assert {str(a["ACTION"]) for a in alarms} == {"DISPLAY"}


def test_all_day_event_dtend_is_end_plus_one_day(built):
    from icalendar import Calendar

    cal = Calendar.from_ical(text_of(built, "all.ics"))
    events = cal.walk("VEVENT")
    assert events

    target = [e for e in events if str(e["UID"]) == "sigcomm-2026-event@conf-deadlines.github.io"]
    assert target, f"expected event UID missing; got {[str(e['UID']) for e in events]}"
    ev = target[0]

    start = ev["DTSTART"].dt
    end = ev["DTEND"].dt
    assert isinstance(start, date) and not isinstance(start, datetime)
    assert isinstance(end, date) and not isinstance(end, datetime)
    assert start == date(2026, 8, 17)
    assert end == date(2026, 8, 22), "DTEND must be the exclusive end (last day + 1)"
    assert not ev.walk("VALARM"), "all-day events carry no alarms"


def test_all_day_events_use_value_date(built):
    lines = unfold_ics(text_of(built, "all.ics"))
    # 開催日（-event 行）の DTSTART のみ VALUE=DATE。締切行はタイムスタンプ。
    starts = [ln for ln in lines if ln.startswith("DTSTART")]
    event_starts = [ln for ln in starts if "VALUE=DATE" in ln]
    assert event_starts, "開催日イベントの DTSTART が見つからない"
    for ln in event_starts:
        assert "VALUE=DATE" in ln
        assert re.search(r":\d{8}$", ln), ln


def test_deadline_timestamps_are_utc_z_form(built):
    lines = unfold_ics(text_of(built, "deadlines.ics"))
    for ln in lines:
        if ln.startswith("DTSTART:") or ln.startswith("DTEND:"):
            assert re.fullmatch(r"DT(START|END):\d{8}T\d{6}Z", ln), ln


# --- feed partitioning -----------------------------------------------------


def _uids(outdir, name):
    from icalendar import Calendar

    cal = Calendar.from_ical(text_of(outdir, name))
    return {str(e["UID"]) for e in cal.walk("VEVENT")}


def test_estimated_editions_are_only_in_the_estimated_feed(built):
    estimated = _uids(built, "all-estimated.ics")
    assert any(u.startswith("sigcomm-2027-") for u in estimated)
    for name in ("all.ics", "deadlines.ics", "networking.ics"):
        assert not any(u.startswith("sigcomm-2027-") for u in _uids(built, name)), name


def test_category_feeds_are_subsets_of_all(built):
    everything = _uids(built, "all.ics")
    for name in ("networking.ics", "hpc.ics", "deadlines.ics"):
        assert _uids(built, name) <= everything, name


def test_category_feeds_are_disjoint(built):
    assert not (_uids(built, "networking.ics") & _uids(built, "hpc.ics"))
    assert any(u.startswith("sigcomm-2026-") for u in _uids(built, "networking.ics"))
    assert any(u.startswith("sc-2026-") for u in _uids(built, "hpc.ics"))


def test_deadline_feed_has_no_event_rows(built):
    assert not any("-event@" in u for u in _uids(built, "deadlines.ics"))


def test_uids_are_stable_and_unique(built):
    from icalendar import Calendar

    cal = Calendar.from_ical(text_of(built, "all.ics"))
    uids = [str(e["UID"]) for e in cal.walk("VEVENT")]
    assert len(uids) == len(set(uids)), "duplicate UIDs"
    for uid in uids:
        assert re.fullmatch(r"[^@\s]+@[^@\s]+", uid), uid
    assert "sigcomm-2026-paper-1@conf-deadlines.github.io" in uids
    assert "sigcomm-2026-event@conf-deadlines.github.io" in uids


UID_RE = re.compile(
    r"^[a-z0-9][a-z0-9-]*-(19|20)\d\d-"
    r"(abstract|paper|supplementary|notification|camera_ready|rebuttal_start"
    r"|rebuttal_end|review_release|registration|other|event)"
    r"(-\d+)?@conf-deadlines\.github\.io$"
)


def test_uids_follow_the_spec_shape(built):
    """SPEC.md 4.1: {key}-{year}-{kind}-{ordinal}@conf-deadlines.github.io."""
    from icalendar import Calendar

    for name in ("all.ics", "all-estimated.ics"):
        cal = Calendar.from_ical(text_of(built, name))
        uids = [str(e["UID"]) for e in cal.walk("VEVENT")]
        assert uids, name
        bad = [u for u in uids if not UID_RE.match(u)]
        assert not bad, f"{name}: {bad[:3]}"
        # The edition id must not leak into the UID: it is not unique upstream.
        assert not [u for u in uids if u.startswith("sigcomm26")], uids


def test_uid_domain_is_frozen_and_independent_of_config(tmp_path, make_conf, repo_config):
    """Changing site.domain must not re-issue every subscriber's events."""
    from icalendar import Calendar

    from scripts.build import build_all

    seen = []
    for domain in ("conf-deadlines.github.io", "somebody-else.example.com"):
        config = copy.deepcopy(repo_config)
        config.setdefault("site", {})["domain"] = domain
        config["site"]["base_url"] = f"https://{domain}/x"
        outdir = tmp_path / domain
        outdir.mkdir(parents=True, exist_ok=True)
        build_all(_conferences(make_conf), config, outdir, NOW)
        cal = Calendar.from_ical((outdir / "all.ics").read_bytes().decode("utf-8"))
        seen.append(sorted(str(e["UID"]) for e in cal.walk("VEVENT")))

    assert seen[0] == seen[1]
    assert all(u.endswith("@conf-deadlines.github.io") for u in seen[0])


def test_uid_ordinal_follows_deadline_time_not_the_upstream_array_order(
    tmp_path, make_conf, repo_config
):
    """SPEC.md 4.1: `round` is the timeline array index and upstream reorders it."""
    from icalendar import Calendar

    from scripts.build import build_all

    early = datetime(2026, 1, 10, 12, 0, 0, tzinfo=UTC)
    late = datetime(2026, 6, 10, 12, 0, 0, tzinfo=UTC)

    def build(first_round_at, second_round_at):
        conf = make_conf.conference(
            key="nsdi",
            title="NSDI",
            categories=["networking"],
            editions=[
                make_conf.edition(
                    year=2026,
                    edition_id="nsdi26",
                    deadlines=[
                        make_conf.deadline("paper", "r1", first_round_at, "AoE", round=1),
                        make_conf.deadline("paper", "r2", second_round_at, "AoE", round=2),
                    ],
                )
            ],
        )
        outdir = tmp_path / f"{first_round_at:%m%d}"
        outdir.mkdir(parents=True, exist_ok=True)
        build_all([conf], copy.deepcopy(repo_config), outdir, NOW)
        cal = Calendar.from_ical((outdir / "all.ics").read_bytes().decode("utf-8"))
        return {str(e["UID"]): e["DTEND"].dt for e in cal.walk("VEVENT")}

    ascending = build(early, late)
    reordered = build(late, early)  # upstream reordered the timeline array
    assert ascending == reordered, "a UID must keep pointing at the same deadline"
    assert ascending["nsdi-2026-paper-1@conf-deadlines.github.io"] == early
    assert ascending["nsdi-2026-paper-2@conf-deadlines.github.io"] == late


def test_url_property_is_not_text_escaped(tmp_path, make_conf, repo_config):
    """URL is a URI value (RFC 5545 3.8.4.6); escaping ',' breaks the link."""
    from scripts.build import build_all

    link = "https://example.org/cfp?a=1,2;b=3"
    conf = make_conf.conference(
        key="sigcomm",
        title="SIGCOMM",
        link=link,
        categories=["networking"],
        editions=[
            make_conf.edition(
                year=2026,
                edition_id="sigcomm26",
                link=link,
                deadlines=[make_conf.deadline("paper", "p", PAPER_AT, "AoE")],
            )
        ],
    )
    outdir = tmp_path / "uri"
    outdir.mkdir(parents=True, exist_ok=True)
    build_all([conf], copy.deepcopy(repo_config), outdir, NOW)

    lines = unfold_ics((outdir / "all.ics").read_bytes().decode("utf-8"))
    urls = [ln.split(":", 1)[1] for ln in lines if ln.startswith("URL:")]
    assert urls == [link] * len(urls)
    assert urls


def test_dtstamp_is_derived_from_now_not_wall_clock(built):
    from icalendar import Calendar

    cal = Calendar.from_ical(text_of(built, "all.ics"))
    stamps = {e["DTSTAMP"].dt for e in cal.walk("VEVENT")}
    assert len(stamps) == 1, "DTSTAMP must be uniform within one build"
    stamp = next(iter(stamps))
    assert abs(stamp - NOW) <= timedelta(days=1)


def test_last_modified_is_absent(built):
    assert "LAST-MODIFIED" not in text_of(built, "all.ics")


# --- determinism -----------------------------------------------------------


def test_two_builds_with_the_same_now_are_byte_identical(
    tmp_path, make_conf, repo_config
):
    from scripts.build import build_all

    first = tmp_path / "a"
    second = tmp_path / "b"
    for outdir in (first, second):
        outdir.mkdir(parents=True, exist_ok=True)
        build_all(
            _conferences(make_conf), copy.deepcopy(repo_config), outdir, NOW
        )

    names = sorted(p.name for p in first.glob("*.ics"))
    assert names, "no calendars generated"
    for name in names:
        assert (first / name).read_bytes() == (second / name).read_bytes(), name


def test_vevent_count_matches_the_input(built):
    from icalendar import Calendar

    deadlines = Calendar.from_ical(text_of(built, "deadlines.ics")).walk("VEVENT")
    estimated = Calendar.from_ical(text_of(built, "all-estimated.ics")).walk("VEVENT")

    # 2 SIGCOMM 2026 deadlines + 1 SC 2026 deadline, none of them estimated.
    assert len(deadlines) == 3
    # One estimated paper deadline.
    assert len(estimated) == 1


def test_blocks_are_well_formed(built):
    blocks = vevent_blocks(unfold_ics(text_of(built, "all.ics")))
    assert blocks
    for block in blocks:
        keys = [ln.split(":", 1)[0].split(";", 1)[0] for ln in block]
        for required in ("UID", "DTSTAMP", "DTSTART", "SUMMARY"):
            assert required in keys, f"{required} missing from a VEVENT"
