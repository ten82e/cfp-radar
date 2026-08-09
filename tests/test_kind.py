"""kind_of: SPEC.md section 3.3, against the upstream type names listed in 1.1 / 1.2."""

from __future__ import annotations

import pytest

# SPEC.md 3.3: ten kinds.  The upstream meaning must not be collapsed.
KINDS = {
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
}

# A transcription of the SPEC.md 3.3 table.  Every ``deadlines[].type`` value
# SPEC.md 1.2 records as existing upstream, plus the ccfddl timeline keys of 1.1.
SPEC_TABLE = [
    ("deadline", "paper"),
    ("paper", "paper"),
    ("submission", "paper"),
    ("full_paper", "paper"),
    ("abstract_deadline", "abstract"),
    ("abstract deadline", "abstract"),
    ("abstract", "abstract"),
    ("supplementary", "supplementary"),
    ("notification", "notification"),
    ("first-notification", "notification"),
    ("final-notification", "notification"),
    ("camera_ready", "camera_ready"),
    ("camera-ready", "camera_ready"),
    ("revision-deadline", "camera_ready"),
    ("rebuttal_start", "rebuttal_start"),
    ("rebuttal_end", "rebuttal_end"),
    ("rebuttal", "rebuttal_end"),
    ("rebuttal_and_revision", "rebuttal_end"),
    ("author_response", "rebuttal_end"),
    ("review_release", "review_release"),
    ("registration", "registration"),
    ("reviewer_registration", "registration"),
    ("commitment_deadline", "registration"),
    ("withdrawal", "other"),
]

UPSTREAM_TYPES = [raw for raw, _ in SPEC_TABLE]


@pytest.mark.parametrize("raw", UPSTREAM_TYPES)
def test_every_upstream_type_maps_into_the_ten_kinds(raw):
    from scripts.model import kind_of

    assert kind_of(raw) in KINDS


@pytest.mark.parametrize("raw,expected", SPEC_TABLE)
def test_explicit_mapping(raw, expected):
    from scripts.model import kind_of

    assert kind_of(raw) == expected


def test_ccfddl_main_deadline_key_is_a_paper_deadline():
    """`deadline` is ccfddl's key for 1591 body deadlines; losing it empties the feed."""
    from scripts.model import kind_of

    assert kind_of("deadline") == "paper"


def test_supplementary_is_not_collapsed_into_paper():
    """CVPR files body and supplement on different days."""
    from scripts.model import kind_of

    assert kind_of("supplementary") == "supplementary"
    assert kind_of("supplementary") != kind_of("paper")


def test_rebuttal_start_and_end_are_distinct():
    """AAAI opens and closes its rebuttal on different days."""
    from scripts.model import kind_of

    assert kind_of("rebuttal_start") != kind_of("rebuttal_end")
    assert kind_of("review_release") not in {
        kind_of("rebuttal_start"),
        kind_of("rebuttal_end"),
    }


@pytest.mark.parametrize("raw", ["withdrawal", "banquet", "", "something-else"])
def test_unmapped_types_fall_back_to_other(raw):
    from scripts.model import kind_of

    assert kind_of(raw) == "other"


def test_mapping_is_total_and_pure():
    """No exception for arbitrary input, and repeated calls agree."""
    from scripts.model import kind_of

    for raw in UPSTREAM_TYPES + ["???", "PAPER"]:
        assert kind_of(raw) == kind_of(raw)
        assert kind_of(raw) in KINDS


def test_declared_kinds_match_the_spec_table():
    from scripts.model import KINDS as DECLARED

    assert set(DECLARED) == KINDS
