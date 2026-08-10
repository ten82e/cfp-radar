"""merge / classify / overrides / rollforward / select: SPEC.md sections 3 and 5."""

from __future__ import annotations

import copy
from datetime import date, datetime, timedelta, timezone

import pytest

UTC = timezone.utc
TODAY = date(2026, 8, 9)


def utc(y, mo, d, h=23, mi=59, s=59) -> datetime:
    return datetime(y, mo, d, h, mi, s, tzinfo=UTC)


def deadlines_of(conf):
    return [dl for ed in conf.editions for dl in ed.deadlines]


def edition_by_year(conf, year):
    matches = [ed for ed in conf.editions if ed.year == year]
    assert matches, f"no edition for {year}: {[e.year for e in conf.editions]}"
    return matches[0]


def by_key(confs):
    return {c.key: c for c in confs}


# --- merge_sources ---------------------------------------------------------


def test_two_sources_for_the_same_conference_are_merged(make_conf):
    from scripts.merge import merge_sources

    ccf = make_conf.conference(
        key="acl",
        title="ACL",
        upstream_sub="AI",
        sources=["ccfddl"],
        rank={"ccf": "A", "core": "A*"},
        editions=[
            make_conf.edition(
                year=2026,
                edition_id="acl26",
                date_text="July 2 - 7, 2026",
                source="ccfddl",
                deadlines=[
                    make_conf.deadline("paper", "Paper", utc(2026, 1, 5), "AoE")
                ],
            )
        ],
    )
    hf = make_conf.conference(
        key="acl",
        title="ACL",
        sources=["aideadlines"],
        editions=[
            make_conf.edition(
                year=2026,
                edition_id="acl26",
                event_start=date(2026, 7, 2),
                event_end=date(2026, 7, 7),
                source="aideadlines",
                deadlines=[
                    make_conf.deadline(
                        "notification", "Notification", utc(2026, 3, 26), "AoE"
                    )
                ],
            )
        ],
    )

    merged = merge_sources([[ccf], [hf]], {})
    assert len(merged) == 1
    conf = merged[0]
    assert conf.key == "acl"
    assert set(conf.sources) == {"ccfddl", "aideadlines"}
    assert len(conf.editions) == 1, "same (key, year) must not be duplicated"
    kinds = {dl.kind for dl in deadlines_of(conf)}
    assert kinds == {"paper", "notification"}, "deadlines must be unioned"


def test_real_edition_replaces_estimated_one(make_conf):
    """A real edition for a year replaces the estimated one (SPEC.md 3.6).

    The estimate's deadlines are a copy of the previous year's, so they must
    not stand beside the real ones; the estimated flag has to go as well.
    Regression: DASFAA 2027 kept 9/22+9/29 estimates next to the real 6/6.
    """
    from scripts.merge import merge_sources

    ccf = make_conf.conference(
        key="dasfaa",
        title="DASFAA",
        sources=["ccfddl"],
        editions=[
            make_conf.edition(
                year=2026,
                edition_id="dasfaa26",
                source="ccfddl",
                deadlines=[
                    make_conf.deadline("paper", "Paper", utc(2025, 10, 28), "AoE")
                ],
            ),
            make_conf.edition(
                year=2027,
                edition_id="dasfaa27-est",
                estimated=True,
                source="ccfddl",
                deadlines=[
                    make_conf.deadline("abstract", "Abstract", utc(2026, 9, 22), "AoE"),
                    make_conf.deadline("paper", "Paper", utc(2026, 9, 29), "AoE"),
                ],
            ),
        ],
    )
    local = make_conf.conference(
        key="dasfaa",
        title="DASFAA",
        sources=["local"],
        editions=[
            make_conf.edition(
                year=2027,
                edition_id="dasfaa27",
                source="local",
                deadlines=[
                    make_conf.deadline("paper", "Full Paper", utc(2027, 6, 7), "AoE")
                ],
            )
        ],
    )

    for groups in ([[local], [ccf]], [[ccf], [local]]):
        merged = merge_sources(groups, {"source_priority": ["local", "ccfddl"]})
        assert len(merged) == 1
        ed27 = edition_by_year(merged[0], 2027)
        assert not ed27.estimated, "the real edition must clear the estimated flag"
        assert [(d.kind, d.at_utc) for d in ed27.deadlines] == [
            ("paper", utc(2027, 6, 7))
        ], "estimated deadlines must not survive next to the real ones"


def test_distinct_conferences_are_kept_apart(make_conf):
    from scripts.merge import merge_sources

    a = make_conf.conference(key="sigcomm", title="SIGCOMM")
    b = make_conf.conference(key="nsdi", title="NSDI")
    merged = merge_sources([[a], [b]], {})
    assert {c.key for c in merged} == {"sigcomm", "nsdi"}


def test_rounds_are_preserved(make_conf):
    """NSDI has two submission rounds per edition; both must survive the merge."""
    from scripts.merge import merge_sources

    conf = make_conf.conference(
        key="nsdi",
        title="NSDI",
        upstream_sub="NW",
        editions=[
            make_conf.edition(
                year=2027,
                edition_id="nsdi27",
                deadlines=[
                    make_conf.deadline(
                        "abstract", "Abstract r1", utc(2026, 4, 16), "UTC-4", round=1
                    ),
                    make_conf.deadline(
                        "paper", "Paper r1", utc(2026, 4, 23), "UTC-4", round=1
                    ),
                    make_conf.deadline(
                        "abstract", "Abstract r2", utc(2026, 9, 10), "UTC-4", round=2
                    ),
                    make_conf.deadline(
                        "paper", "Paper r2", utc(2026, 9, 17), "UTC-4", round=2
                    ),
                ],
            )
        ],
    )
    merged = merge_sources([[conf]], {})
    dls = deadlines_of(merged[0])
    assert len(dls) == 4
    assert {(dl.kind, dl.round) for dl in dls} == {
        ("abstract", 1),
        ("paper", 1),
        ("abstract", 2),
        ("paper", 2),
    }


def test_conflicting_deadline_resolved_by_source_priority(make_conf):
    from scripts.merge import merge_sources

    # Two instants more than the one-to-one runaway guard (7 d) apart.  Within
    # that guard a 1-vs-1 pair is folded as the same deadline transcribed twice;
    # beyond it they are two real deadlines and both must survive.
    low = make_conf.conference(
        key="sigcomm",
        title="SIGCOMM",
        sources=["ccfddl"],
        editions=[
            make_conf.edition(
                year=2026,
                edition_id="sigcomm26",
                source="ccfddl",
                deadlines=[
                    make_conf.deadline("paper", "ccf", utc(2026, 2, 6), "AoE", round=1)
                ],
            )
        ],
    )
    high = make_conf.conference(
        key="sigcomm",
        title="SIGCOMM",
        sources=["aideadlines"],
        editions=[
            make_conf.edition(
                year=2026,
                edition_id="sigcomm26",
                source="aideadlines",
                deadlines=[
                    make_conf.deadline("paper", "hf", utc(2026, 2, 20), "AoE", round=1)
                ],
            )
        ],
    )

    config = {"source_priority": ["local", "aideadlines", "ccfddl"]}
    merged = merge_sources([[low], [high]], config)
    dls = [dl for dl in deadlines_of(merged[0]) if dl.kind == "paper" and dl.round == 1]
    assert {dl.at_utc for dl in dls} == {utc(2026, 2, 6), utc(2026, 2, 20)}

    flipped = merge_sources(
        [[low], [high]], {"source_priority": ["ccfddl", "aideadlines", "local"]}
    )
    dls = [
        dl for dl in deadlines_of(flipped[0]) if dl.kind == "paper" and dl.round == 1
    ]
    assert {dl.at_utc for dl in dls} == {utc(2026, 2, 6), utc(2026, 2, 20)}


def test_identical_deadlines_from_two_sources_are_not_duplicated(make_conf):
    """Same (round, kind, at_utc) from both upstreams is one deadline."""
    from scripts.merge import merge_sources

    def one(source, label):
        return make_conf.conference(
            key="sigcomm",
            title="SIGCOMM",
            sources=[source],
            editions=[
                make_conf.edition(
                    year=2026,
                    edition_id="sigcomm26",
                    source=source,
                    deadlines=[
                        make_conf.deadline(
                            "paper", label, utc(2026, 2, 6), "AoE", round=1
                        )
                    ],
                )
            ],
        )

    merged = merge_sources(
        [[one("ccfddl", "ccf")], [one("aideadlines", "hf")]],
        {"source_priority": ["local", "aideadlines", "ccfddl"]},
    )
    dls = deadlines_of(merged[0])
    assert len(dls) == 1
    assert dls[0].label == "hf", "the priority source wins the label"


def test_three_notifications_in_one_edition_survive_a_merge(make_conf):
    """SPEC.md 3.6: (year, round, kind) collapses 127 of hf's 473 deadlines."""
    from scripts.merge import merge_sources

    days = (5, 20, 25)
    hf = make_conf.conference(
        key="sigcomm",
        title="SIGCOMM",
        sources=["aideadlines"],
        editions=[
            make_conf.edition(
                year=2026,
                edition_id="sigcomm26",
                source="aideadlines",
                deadlines=[
                    make_conf.deadline(
                        "notification", f"n{d}", utc(2026, 3, d), "AoE", round=1
                    )
                    for d in days
                ],
            )
        ],
    )
    ccf = make_conf.conference(
        key="sigcomm",
        title="SIGCOMM",
        sources=["ccfddl"],
        editions=[
            make_conf.edition(
                year=2026,
                edition_id="sigcomm26",
                source="ccfddl",
                deadlines=[
                    make_conf.deadline(
                        "notification", "ccf", utc(2026, 3, 5), "AoE", round=1
                    )
                ],
            )
        ],
    )
    for groups in ([[hf], [ccf]], [[ccf], [hf]]):
        merged = merge_sources(
            groups, {"source_priority": ["local", "aideadlines", "ccfddl"]}
        )
        kept = {dl.at_utc for dl in deadlines_of(merged[0])}
        assert kept == {utc(2026, 3, d) for d in days}


# --- classify --------------------------------------------------------------


def test_classify_assigns_categories_from_upstream_sub(make_conf, repo_config):
    from scripts.merge import classify

    nw = make_conf.conference(key="sigcomm", title="SIGCOMM", upstream_sub="NW")
    out = by_key(classify([nw], repo_config))
    assert "networking" in out["sigcomm"].categories


def test_classify_places_sc_in_hpc(make_conf, repo_config):
    from scripts.merge import classify

    sc = make_conf.conference(key="sc", title="SC", upstream_sub="DS")
    out = by_key(classify([sc], repo_config))
    assert "hpc" in out["sc"].categories


def test_classify_only_uses_declared_categories(make_conf, repo_config):
    from scripts.merge import classify

    allowed = {"hpc", "networking", "systems", "ai", "security"}
    confs = [
        make_conf.conference(key="sigcomm", title="SIGCOMM", upstream_sub="NW"),
        make_conf.conference(key="sc", title="SC", upstream_sub="DS"),
        make_conf.conference(key="neurips", title="NeurIPS", upstream_sub="AI"),
    ]
    for conf in classify(confs, repo_config):
        assert set(conf.categories) <= allowed


# --- apply_overrides -------------------------------------------------------


def test_empty_overrides_is_a_no_op(make_conf):
    from scripts.merge import apply_overrides

    confs = [
        make_conf.conference(
            key="sigcomm",
            title="SIGCOMM",
            editions=[
                make_conf.edition(
                    year=2026,
                    edition_id="sigcomm26",
                    deadlines=[
                        make_conf.deadline("paper", "Paper", utc(2026, 2, 6), "AoE")
                    ],
                )
            ],
        )
    ]
    before = copy.deepcopy(confs)
    out = apply_overrides(confs, {})
    assert [c.key for c in out] == [c.key for c in before]
    assert deadlines_of(out[0]) == deadlines_of(before[0])


def test_repo_overrides_file_applies_without_error(make_conf):
    """data/overrides.yaml must stay loadable and applicable to a plain input."""
    import yaml

    from scripts.merge import apply_overrides
    from tests.conftest import REPO_ROOT

    path = REPO_ROOT / "data" / "overrides.yaml"
    if not path.exists():
        pytest.skip("data/overrides.yaml not present yet")
    with path.open(encoding="utf-8") as fh:
        overrides = yaml.safe_load(fh) or {}
    confs = [make_conf.conference(key="sigcomm", title="SIGCOMM")]
    out = apply_overrides(confs, overrides)
    assert isinstance(out, list)
    assert all(hasattr(c, "key") for c in out)


def test_override_replaces_deadlines(make_conf):
    """overrides editions.<year>.deadlines replaces the edition's deadlines.

    Used for extensions and corrections: upstream keeps the pre-extension date,
    the override swaps it without leaving the stale deadline behind (MMM 2027
    pattern).  The replaced edition must stay real so rollforward does not
    re-invent the estimate.
    """
    from scripts.merge import apply_overrides

    confs = [
        make_conf.conference(
            key="mmm",
            title="MMM",
            editions=[
                make_conf.edition(
                    year=2027,
                    edition_id="mmm27",
                    deadlines=[
                        make_conf.deadline("paper", "Paper", utc(2026, 8, 17), "AoE")
                    ],
                )
            ],
        )
    ]
    overrides = {
        "conferences": {
            "mmm": {
                "editions": {
                    2027: {
                        "deadlines": [
                            {
                                "kind": "paper",
                                "label": "Regular paper submission (extended)",
                                "date": "2026-08-30 23:59:00",
                                "tz": "AoE",
                            }
                        ]
                    }
                }
            }
        }
    }
    out = apply_overrides(confs, overrides)
    edition = out[0].editions[0]
    assert len(edition.deadlines) == 1
    assert edition.deadlines[0].at_utc == utc(2026, 8, 31, 11, 59, 0)
    assert edition.deadlines[0].label == "Regular paper submission (extended)"


def test_override_adds_missing_edition(make_conf):
    """上流に無い edition の patch は新規 edition として追加される (SETTA 2026 経路)。

    primary_overrides が上流の未収録 edition を一次ソースの実測で埋めるための経路。
    追加された edition は real (estimated=False) なので rollforward はそれを基準に
    次 edition を推定する。
    """
    from scripts.merge import apply_overrides

    confs = [
        make_conf.conference(
            key="setta",
            title="SETTA",
            editions=[
                make_conf.edition(
                    year=2025,
                    edition_id="setta25",
                    deadlines=[
                        make_conf.deadline("paper", "Paper", utc(2025, 8, 20), "AoE")
                    ],
                )
            ],
        )
    ]
    overrides = {
        "conferences": {
            "setta": {
                "editions": {
                    2026: {
                        "link": "https://www.setta2026.sg",
                        "place": "Singapore",
                        "date_text": "December 2-4, 2026",
                        "deadlines": [
                            {
                                "kind": "paper",
                                "label": "Paper submission",
                                "date": "2026-05-10",
                            }
                        ],
                    }
                }
            }
        }
    }
    out = apply_overrides(confs, overrides)
    editions = {e.year: e for e in out[0].editions}
    assert 2026 in editions
    added = editions[2026]
    assert added.estimated is False
    assert added.link == "https://www.setta2026.sg"
    assert added.place == "Singapore"
    assert added.deadlines[0].at_utc == utc(2026, 5, 10, 23, 59, 59)
    # 既存 edition は置き換えられない
    assert editions[2025].deadlines[0].at_utc == utc(2025, 8, 20)


# --- rollforward -----------------------------------------------------------


def _stale_conference(make_conf):
    """Latest paper deadline AND event are in the past relative to TODAY (2026-08-09).

    Paper on 2025-09-12 so one 364-day step lands on 2026-09-11 (still ahead of
    TODAY); two steps would overshoot.  The meeting itself is also past so the
    event-ahead guard does not block estimation.
    """
    return make_conf.conference(
        key="sc",
        title="SC",
        upstream_sub="DS",
        editions=[
            make_conf.edition(
                year=2025,
                edition_id="sc25",
                date_text="November 16-21, 2025",
                event_start=date(2025, 11, 16),
                event_end=date(2025, 11, 21),
                deadlines=[
                    make_conf.deadline(
                        "abstract", "Abstract", utc(2025, 9, 5, 11, 59, 59), "AoE"
                    ),
                    make_conf.deadline(
                        "paper", "Paper", utc(2025, 9, 12, 11, 59, 0), "AoE"
                    ),
                ],
            )
        ],
    )


def test_rollforward_adds_one_estimated_edition(make_conf, repo_config):
    from scripts.merge import rollforward

    conf = _stale_conference(make_conf)
    out = by_key(rollforward([conf], TODAY, repo_config))["sc"]

    estimated = [ed for ed in out.editions if ed.estimated]
    assert len(estimated) == 1, "exactly one estimated edition must be added"
    assert len([ed for ed in out.editions if not ed.estimated]) == 1

    paper = [dl for dl in estimated[0].deadlines if dl.kind == "paper"]
    assert paper, "the estimated edition must carry a paper deadline"
    expected = utc(2025, 9, 12, 11, 59, 0) + timedelta(days=364)
    assert paper[0].at_utc.date() == expected.date()
    assert paper[0].at_utc.weekday() == utc(2025, 9, 12).weekday(), "weekday preserved"


def test_estimated_edition_year_agrees_with_the_dates_it_carries(
    make_conf, repo_config
):
    """A venue whose round layout changes yields a sub-annual interval estimate.

    The year label must follow the shift actually applied, otherwise the
    edition is labelled two years out while carrying next month's deadline.
    """
    from scripts.merge import rollforward

    conf = make_conf.conference(
        key="sac",
        title="SAC",
        upstream_sub="SE",
        editions=[
            make_conf.edition(
                year=2025,
                edition_id="sac25",
                deadlines=[
                    make_conf.deadline("paper", "R1", utc(2025, 1, 28, 11, 59, 59), "AoE")
                ],
            ),
            make_conf.edition(
                year=2026,
                edition_id="sac26",
                deadlines=[
                    make_conf.deadline(
                        "paper", "R1", utc(2025, 5, 12, 11, 59, 59), "AoE"
                    ),
                    make_conf.deadline(
                        "paper", "R2", utc(2026, 2, 3, 11, 59, 59), "AoE", round=2
                    ),
                ],
            ),
        ],
    )
    out = by_key(rollforward([conf], TODAY, repo_config))["sac"]
    estimated = [ed for ed in out.editions if ed.estimated]
    assert len(estimated) == 1
    edition = estimated[0]
    assert edition.deadlines
    for dl in edition.deadlines:
        assert abs(dl.at_utc.year - edition.year) <= 1, (
            f"edition {edition.year} carries a {dl.at_utc.date()} deadline"
        )


def test_rollforward_does_not_touch_a_conference_with_a_future_edition(
    make_conf, repo_config
):
    from scripts.merge import rollforward

    conf = make_conf.conference(
        key="nsdi",
        title="NSDI",
        upstream_sub="NW",
        editions=[
            make_conf.edition(
                year=2026,
                edition_id="nsdi26",
                deadlines=[
                    make_conf.deadline("paper", "Paper", utc(2025, 9, 19, 3), "UTC-7")
                ],
            ),
            make_conf.edition(
                year=2027,
                edition_id="nsdi27",
                deadlines=[
                    make_conf.deadline(
                        "paper", "Paper", utc(2026, 9, 17, 3), "UTC-4", round=2
                    )
                ],
            ),
        ],
    )
    before = copy.deepcopy(conf)
    out = by_key(rollforward([conf], TODAY, repo_config))["nsdi"]

    assert not any(ed.estimated for ed in out.editions)
    assert len(out.editions) == len(before.editions)
    assert {ed.year for ed in out.editions} == {2026, 2027}


def test_rollforward_skips_when_only_the_event_is_still_ahead(make_conf, repo_config):
    """IMC 2026: papers closed, conference still upcoming → do not invent 2027 yet.

    Real bug (2026-08-09): `_is_future` returned False as soon as any paper
    deadline existed and was past, ignoring a future event_end.  That spawned
    an IMC 2027 estimate with August deadlines while IMC 2026 had not met.
    """
    from scripts.merge import rollforward

    conf = make_conf.conference(
        key="imc",
        title="IMC",
        upstream_sub="NW",
        editions=[
            make_conf.edition(
                year=2026,
                edition_id="imc26",
                event_start=date(2026, 10, 12),
                event_end=date(2026, 10, 16),
                deadlines=[
                    make_conf.deadline(
                        "paper", "Cycle 2", utc(2026, 4, 29, 11, 59, 59), "AoE", round=2
                    )
                ],
            )
        ],
    )
    out = by_key(rollforward([conf], TODAY, repo_config))["imc"]
    assert not any(ed.estimated for ed in out.editions)
    assert [ed.year for ed in out.editions] == [2026]


def test_rollforward_leaves_conferences_without_deadlines_alone(
    make_conf, repo_config
):
    """Event-only entries (SPEC 5: no fabricated deadlines) must not gain one."""
    from scripts.merge import rollforward

    conf = make_conf.conference(
        key="iots",
        title="IOTS",
        editions=[
            make_conf.edition(
                year=2025,
                edition_id="iots25",
                event_start=date(2025, 12, 3),
                event_end=date(2025, 12, 5),
                source="local",
            )
        ],
    )
    out = by_key(rollforward([conf], TODAY, repo_config))["iots"]
    assert not any(dl.kind == "paper" for dl in deadlines_of(out))


# --- select ----------------------------------------------------------------


def test_select_is_non_destructive(make_conf, repo_config):
    from scripts.merge import select

    confs = [
        make_conf.conference(
            key="sigcomm",
            title="SIGCOMM",
            upstream_sub="NW",
            rank={"ccf": "A", "core": "A*"},
            categories=["networking"],
        ),
        make_conf.conference(
            key="prcv",
            title="PRCV",
            upstream_sub="CG",
            rank={"ccf": "C", "core": "N"},
            categories=[],
        ),
    ]
    original_ids = [id(c) for c in confs]
    out = select(confs, repo_config)

    assert out is not confs
    assert [id(c) for c in confs] == original_ids, "input list must not be rebound"
    assert len(confs) == 2, "input list must not be mutated"
    assert {c.key for c in out} <= {"sigcomm", "prcv"}


def test_select_keeps_unranked_conference_when_configured(make_conf, repo_config):
    from scripts.merge import select

    if not repo_config.get("rank_filter", {}).get("keep_if_no_rank", True):
        pytest.skip("config disables keep_if_no_rank")
    conf = make_conf.conference(
        key="isc-hpc",
        title="ISC High Performance",
        rank={},
        categories=["hpc"],
        sources=["local"],
        editions=[
            make_conf.edition(
                year=2027,
                edition_id="isc27",
                event_start=date(2027, 6, 7),
                event_end=date(2027, 6, 11),
                source="local",
            )
        ],
    )
    out = select([conf], repo_config)
    assert [c.key for c in out] == ["isc-hpc"]


# --- deadline de-duplication (SPEC.md 3.6 tolerance window) ----------------


def _sigcomm(make_conf, source, deadlines, year=2026):
    return make_conf.conference(
        key="sigcomm",
        title="SIGCOMM",
        sources=[source],
        editions=[
            make_conf.edition(
                year=year,
                edition_id=f"sigcomm{year % 100}",
                source=source,
                deadlines=deadlines,
            )
        ],
    )


PRIORITY = {"source_priority": ["local", "aideadlines", "ccfddl"]}


def test_near_duplicate_from_two_sources_is_one_deadline(make_conf):
    """ccfddl says 11:59:00Z and ai-deadlines says 11:59:59Z (NeurIPS, real data)."""
    from scripts.merge import merge_sources

    ccf = _sigcomm(
        make_conf,
        "ccfddl",
        [make_conf.deadline("paper", "Paper submission", utc(2026, 2, 6, 11, 59, 0))],
    )
    hf = _sigcomm(
        make_conf,
        "aideadlines",
        [
            make_conf.deadline(
                "paper", "Paper submission deadline", utc(2026, 2, 6, 11, 59, 59)
            )
        ],
    )
    merged = merge_sources([[ccf], [hf]], PRIORITY)
    dls = deadlines_of(merged[0])
    assert len(dls) == 1
    assert dls[0].at_utc == utc(2026, 2, 6, 11, 59, 59), "priority source keeps its value"
    assert dls[0].label == "Paper submission deadline"
    assert "Paper submission" in (dls[0].comment or ""), "the dropped wording is kept"


def test_same_instant_in_two_rounds_of_one_source_is_one_deadline(make_conf):
    """GECCO lists the identical paper deadline under round 1 and round 2."""
    from scripts.merge import merge_sources

    conf = _sigcomm(
        make_conf,
        "ccfddl",
        [
            make_conf.deadline("paper", "Paper submission", utc(2026, 1, 27), round=1),
            make_conf.deadline("paper", "Paper submission", utc(2026, 1, 27), round=2),
        ],
    )
    merged = merge_sources([[conf]], PRIORITY)
    dls = deadlines_of(merged[0])
    assert len(dls) == 1
    assert dls[0].round == 1


def test_round_disagreement_between_sources_is_one_deadline(make_conf):
    """WACV: ccfddl calls it round 2, ai-deadlines has no rounds and says 1."""
    from scripts.merge import merge_sources

    ccf = _sigcomm(
        make_conf,
        "ccfddl",
        [make_conf.deadline("paper", "Paper submission", utc(2026, 8, 29), round=2)],
    )
    hf = _sigcomm(
        make_conf,
        "aideadlines",
        [
            make_conf.deadline(
                "paper", "Round 2 Paper Submissions", utc(2026, 8, 29), round=1
            )
        ],
    )
    merged = merge_sources([[ccf], [hf]], PRIORITY)
    dls = deadlines_of(merged[0])
    assert len(dls) == 1
    assert dls[0].label == "Round 2 Paper Submissions", "priority keeps the wording"
    assert dls[0].round == 2, (
        "the larger round wins: ai-deadlines has no rounds and always reports 1, "
        "so letting priority decide demotes ccfddl's round 2 (SPEC.md 3.6)"
    )


def test_genuine_rounds_months_apart_are_not_merged(make_conf):
    """NSDI's two rounds are months apart and must both survive."""
    from scripts.merge import merge_sources

    conf = _sigcomm(
        make_conf,
        "ccfddl",
        [
            make_conf.deadline("paper", "Paper submission", utc(2026, 4, 24), round=1),
            make_conf.deadline("paper", "Paper submission", utc(2026, 9, 18), round=2),
        ],
    )
    dls = deadlines_of(merge_sources([[conf]], PRIORITY)[0])
    assert {(d.round, d.at_utc) for d in dls} == {
        (1, utc(2026, 4, 24)),
        (2, utc(2026, 9, 18)),
    }


def test_deadlines_just_outside_the_window_are_not_merged(make_conf):
    from scripts.merge import merge_sources

    conf = _sigcomm(
        make_conf,
        "ccfddl",
        [
            make_conf.deadline("paper", "a", utc(2026, 2, 6, 0, 0, 0)),
            make_conf.deadline("paper", "b", utc(2026, 2, 6, 1, 0, 1)),
        ],
    )
    assert len(deadlines_of(merge_sources([[conf]], PRIORITY)[0])) == 2


def test_different_kinds_at_the_same_instant_are_not_merged(make_conf):
    """CVPR files paper and supplementary at the same instant; both matter."""
    from scripts.merge import merge_sources

    conf = _sigcomm(
        make_conf,
        "ccfddl",
        [
            make_conf.deadline("paper", "Paper", utc(2026, 5, 7)),
            make_conf.deadline("supplementary", "Supplementary", utc(2026, 5, 7)),
        ],
    )
    dls = deadlines_of(merge_sources([[conf]], PRIORITY)[0])
    assert {d.kind for d in dls} == {"paper", "supplementary"}


def test_merge_count_is_reported_in_the_stats(make_conf):
    from scripts.merge import merge_sources

    conf = _sigcomm(
        make_conf,
        "ccfddl",
        [
            make_conf.deadline("paper", "Paper submission", utc(2026, 1, 27), round=1),
            make_conf.deadline("paper", "Paper submission", utc(2026, 1, 27), round=2),
            make_conf.deadline("paper", "Paper submission", utc(2026, 1, 27), round=3),
        ],
    )
    stats: dict = {}
    merge_sources([[conf]], PRIORITY, stats)
    assert stats["merged_deadlines"] == 2
    assert stats["merged_by_key"]["sigcomm"] == 2


def test_cross_source_tolerance_is_configurable(make_conf):
    from scripts.merge import merge_sources

    # Each source lists two paper deadlines so the 1-vs-1 rule does not apply and
    # only the cross-source near-coincidence window decides the fold.  Pin the
    # one-to-one guard to 0 as well so a regression that routes 1-vs-1 through
    # this path cannot silently re-fold the pair.
    ccf = _sigcomm(
        make_conf,
        "ccfddl",
        [
            make_conf.deadline("paper", "Paper submission", utc(2026, 2, 6, 0, 0, 0)),
            make_conf.deadline("paper", "Other track", utc(2026, 3, 1, 0, 0, 0)),
        ],
    )
    hf = _sigcomm(
        make_conf,
        "aideadlines",
        [
            make_conf.deadline("paper", "Paper deadline", utc(2026, 2, 6, 8, 0, 0)),
            make_conf.deadline("paper", "Other track", utc(2026, 3, 1, 0, 0, 0)),
        ],
    )
    tight = dict(
        PRIORITY,
        deadline_merge_cross_source_seconds=0,
        deadline_merge_one_to_one_max_seconds=0,
    )
    # 8 h apart under a zero window: two records.  Default 25 h window: one.
    assert len(deadlines_of(merge_sources([[ccf], [hf]], tight)[0])) == 3  # 2+1 folded other
    # Feb 6 pair folds under default; March 1 pair folds → 2 total
    assert len(deadlines_of(merge_sources([[ccf], [hf]], PRIORITY)[0])) == 2


@pytest.mark.parametrize(
    "hours, why",
    [
        (1, "SGP: 22:59:00Z vs 23:59:59Z, an hour of timezone plus a second of rounding"),
        (4, "FG / IROS: the sources read the same wall clock in different zones"),
        (12, "ICDAR / Interspeech: half a day apart"),
        (24, "CVPR 2026 abstract: the sources disagree about the calendar day"),
    ],
)
def test_sources_disagreeing_by_hours_still_make_one_deadline(make_conf, hours, why):
    """Real cross-source gaps observed in the upstream data (SPEC.md 3.6)."""
    from scripts.merge import merge_sources

    base = utc(2026, 2, 2, 11, 59, 59)
    ccf = _sigcomm(
        make_conf, "ccfddl", [make_conf.deadline("paper", "Paper submission", base)]
    )
    hf = _sigcomm(
        make_conf,
        "aideadlines",
        [
            make_conf.deadline(
                "paper", "Paper Submission", base + timedelta(hours=hours)
            )
        ],
    )
    dls = deadlines_of(merge_sources([[ccf], [hf]], PRIORITY)[0])
    assert len(dls) == 1, why


def test_one_source_filing_several_tracks_at_one_instant_keeps_them_all(make_conf):
    """SIGGRAPH 2026 files three submission tracks at 2026-04-21T22:00:00Z."""
    from scripts.merge import merge_sources

    at = utc(2026, 4, 21, 22, 0, 0)
    conf = _sigcomm(
        make_conf,
        "aideadlines",
        [
            make_conf.deadline("paper", "Appy Hour deadline", at),
            make_conf.deadline("paper", "Posters deadline", at),
            make_conf.deadline("paper", "Student Research Competition deadline", at),
        ],
    )
    dls = deadlines_of(merge_sources([[conf]], PRIORITY)[0])
    assert {d.label for d in dls} == {
        "Appy Hour deadline",
        "Posters deadline",
        "Student Research Competition deadline",
    }


def test_one_source_repeating_a_label_at_one_instant_is_one_deadline(make_conf):
    """GECCO files two tracks under one instant with the same generated label."""
    from scripts.merge import merge_sources

    at = utc(2026, 1, 26, 23, 59, 0)
    conf = _sigcomm(
        make_conf,
        "ccfddl",
        [
            make_conf.deadline("paper", "Paper submission", at, round=1,
                               comment="Full papers"),
            make_conf.deadline("paper", " paper  SUBMISSION ", at, round=2,
                               comment="Poster-only papers"),
        ],
    )
    dls = deadlines_of(merge_sources([[conf]], PRIORITY)[0])
    assert len(dls) == 1
    assert dls[0].round == 1, "within one source the winner keeps its own round"
    assert "Poster-only papers" in (dls[0].comment or ""), "the loser's note survives"


def test_a_cross_source_match_goes_to_the_nearest_candidate(make_conf):
    """SIGGRAPH: ccfddl's paper deadline is inside the window of two ai entries.

    'Technical Papers' is the same deadline; 'Upload and conflicts' the day after
    is a different one.  Taking the first match instead of the nearest attaches
    ccfddl's record to the wrong track.
    """
    from scripts.merge import merge_sources

    at = utc(2026, 1, 22, 22, 0, 0)
    hf = _sigcomm(
        make_conf,
        "aideadlines",
        [
            make_conf.deadline("paper", "Upload and conflicts deadline",
                               at + timedelta(hours=24)),
            make_conf.deadline("paper", "Technical Papers deadline", at),
        ],
    )
    ccf = _sigcomm(
        make_conf, "ccfddl", [make_conf.deadline("paper", "Paper submission", at)]
    )
    dls = deadlines_of(merge_sources([[ccf], [hf]], PRIORITY)[0])
    assert len(dls) == 2
    absorbed = [d for d in dls if "Paper submission" in (d.comment or "")]
    assert [d.label for d in absorbed] == ["Technical Papers deadline"]


def test_dedup_runs_again_behind_rollforward(make_conf):
    """SPEC.md 3.6: an estimated edition must not re-introduce a duplicate."""
    from scripts.merge import dedup_deadlines

    at = utc(2027, 2, 1, 23, 59, 0)
    conf = make_conf.conference(
        key="sgp",
        title="SGP",
        sources=["ccfddl"],
        editions=[
            make_conf.edition(
                year=2027,
                edition_id="sgp27-est",
                estimated=True,
                source="ccfddl",
                deadlines=[
                    make_conf.deadline("paper", "Paper submission", at),
                    make_conf.deadline("paper", "Paper submission", at),
                ],
            )
        ],
    )
    stats: dict = {}
    out = dedup_deadlines([conf], PRIORITY, stats)
    assert len(deadlines_of(out[0])) == 1
    assert stats["merged_deadlines"] == 1
    assert dedup_deadlines(out, PRIORITY) == out, "the pass is idempotent"


# --- select drops content-less conferences ---------------------------------


def test_select_drops_a_conference_with_neither_deadline_nor_meeting_date(
    make_conf, repo_config
):
    from scripts.merge import select

    bare = make_conf.conference(
        key="hpsr", title="HPSR", categories=["networking"], sources=["local"]
    )
    link_only = make_conf.conference(
        key="ieice-ns",
        title="IEICE NS",
        categories=["networking"],
        sources=["local"],
        editions=[make_conf.edition(year=2026, edition_id="ns26", source="local")],
    )
    dated = make_conf.conference(
        key="p4-workshop",
        title="P4 Workshop",
        categories=["networking"],
        sources=["local"],
        editions=[
            make_conf.edition(
                year=2026,
                edition_id="p4ws26",
                event_start=date(2026, 10, 12),
                event_end=date(2026, 10, 12),
                source="local",
            )
        ],
    )
    kept = {c.key for c in select([bare, link_only, dated], repo_config)}
    assert kept == {"p4-workshop"}


def test_select_keeps_taxonomy_venues_despite_low_rank(make_conf, repo_config):
    """Venues named in taxonomy are intentional inclusions; rank must not drop them.

    Real case (2026-08-09): systor / sec / cf / ica3pp etc. sit in config.yaml
    venues but ccf C so rank_filter deleted them before output. Naming a venue is
    a keep decision, not merely a category label.
    """
    from scripts.merge import select

    conf = make_conf.conference(
        key="systor",
        title="SYSTOR",
        rank={"ccf": "C", "core": "N"},
        categories=["systems"],
        editions=[
            make_conf.edition(
                year=2026,
                edition_id="systor26",
                event_start=date(2026, 9, 8),
                event_end=date(2026, 9, 9),
                source="ccfddl",
            )
        ],
    )
    # Sanity: without the taxonomy-venue rule a bare C-rank conf is dropped.
    bare_cfg = {
        "categories": {"systems": "Systems"},
        "rank_filter": {"ccf": ["A", "B"], "keep_if_no_rank": True, "always_keep": []},
        "taxonomy": {},
    }
    assert select([conf], bare_cfg) == []

    out = select([conf], repo_config)
    assert [c.key for c in out] == ["systor"]


def test_select_keeps_every_taxonomy_venue_key(make_conf, repo_config):
    """Every key listed under taxonomy.*.venues survives select at ccf C.

    Pins the full config surface, not a single example venue.
    """
    from scripts.merge import select

    venues: list[str] = []
    for rule in (repo_config.get("taxonomy") or {}).values():
        if isinstance(rule, dict):
            venues.extend(rule.get("venues") or [])
    assert venues, "config.yaml taxonomy must name at least one venue"

    confs = [
        make_conf.conference(
            key=key,
            title=key.upper(),
            rank={"ccf": "C", "core": "N"},
            categories=["systems"],
            editions=[
                make_conf.edition(
                    year=2026,
                    edition_id=f"{key}26",
                    event_start=date(2026, 9, 1),
                    event_end=date(2026, 9, 2),
                    source="ccfddl",
                )
            ],
        )
        for key in venues
    ]
    kept = {c.key for c in select(confs, repo_config)}
    assert kept == set(venues)


def test_sanitize_drops_paper_after_event_end(make_conf):
    """ICASSP 2025 carried the 2026 paper date after the meeting had ended."""
    from scripts.merge import sanitize_editions

    conf = make_conf.conference(
        key="icassp",
        title="ICASSP",
        editions=[
            make_conf.edition(
                year=2025,
                edition_id="icassp25",
                event_start=date(2025, 4, 6),
                event_end=date(2025, 4, 11),
                deadlines=[
                    make_conf.deadline(
                        "paper", "Paper submission", utc(2024, 9, 12, 6, 59, 59)
                    ),
                    make_conf.deadline(
                        "paper", "Paper Submission", utc(2025, 9, 18, 6, 59, 59)
                    ),
                    make_conf.deadline(
                        "camera_ready", "Camera", utc(2025, 5, 1, 0, 0, 0)
                    ),
                ],
            )
        ],
    )
    out = sanitize_editions([conf])[0]
    kinds_times = [(d.kind, d.at_utc) for d in out.editions[0].deadlines]
    assert ( "paper", utc(2024, 9, 12, 6, 59, 59) ) in kinds_times
    assert ( "paper", utc(2025, 9, 18, 6, 59, 59) ) not in kinds_times
    # camera-ready after the meeting is kept (venues do post these mid-event)
    assert any(k == "camera_ready" for k, _ in kinds_times)


def test_sanitize_after_overrides_in_pipeline_shape(make_conf):
    """sanitize is order-independent of overrides: both leave a clean edition."""
    from scripts.merge import apply_overrides, sanitize_editions

    conf = make_conf.conference(
        key="uai",
        title="UAI",
        editions=[
            make_conf.edition(
                year=2026,
                edition_id="uai26",
                date_text="August 17-21, 2025",
                event_start=date(2025, 8, 17),
                event_end=date(2025, 8, 21),
                deadlines=[
                    make_conf.deadline(
                        "paper", "Paper submission", utc(2026, 2, 25, 11, 59, 59)
                    )
                ],
            )
        ],
    )
    overrides = {
        "conferences": {
            "uai": {
                "editions": {
                    2026: {
                        "date_text": "August 17-21, 2026",
                        "event_start": "2026-08-17",
                        "event_end": "2026-08-21",
                    }
                }
            }
        }
    }
    out = sanitize_editions(apply_overrides([conf], overrides))[0]
    ed = out.editions[0]
    assert ed.event_start == date(2026, 8, 17)
    assert ed.event_end == date(2026, 8, 21)
    assert len(ed.deadlines) == 1


def test_local_real_edition_suppresses_same_year_estimate(make_conf, repo_config):
    """Official 2026 CFP must replace a roll-forward estimate on the same year.

    LOG/PDCAT 2025-only upstreams produced estimated 2026 deadlines weeks early
    (2026-08-09 scan).  A local real edition with a future paper deadline must
    win and leave no estimated sibling for that year.
    """
    from scripts.merge import merge_sources, rollforward

    today = date(2026, 8, 9)
    upstream = make_conf.conference(
        key="log",
        title="LOG",
        rank={"ccf": "N"},
        categories=["ai"],
        sources=["ccfddl"],
        editions=[
            make_conf.edition(
                year=2025,
                edition_id="log25",
                event_start=date(2025, 12, 10),
                event_end=date(2025, 12, 12),
                deadlines=[
                    make_conf.deadline(
                        "paper", "Paper submission", utc(2025, 8, 30, 11, 59, 59)
                    )
                ],
                source="ccfddl",
            )
        ],
    )
    local = make_conf.conference(
        key="log",
        title="LOG",
        categories=["ai"],
        sources=["local"],
        editions=[
            make_conf.edition(
                year=2026,
                edition_id="log26",
                event_start=date(2026, 11, 20),
                event_end=date(2026, 11, 22),
                deadlines=[
                    make_conf.deadline(
                        "paper", "Full Paper", utc(2026, 8, 7, 11, 59, 59)
                    )
                ],
                source="local",
            )
        ],
    )
    conf = merge_sources([[local], [upstream]], repo_config)[0]
    conf = rollforward([conf], today, repo_config)[0]
    years = {(e.year, e.estimated) for e in conf.editions}
    assert (2026, False) in years
    assert (2026, True) not in years
