"""Conference keys: SPEC.md section 3.1.

Two things must hold at once: upstream conferences that merely share a slug
(``FSE``, ``SEC``) stay separate, and the same conference spelled differently by
the two upstreams (``KDD`` vs ``SIGKDD``) is merged through ``aliases``.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest
import yaml

from .conftest import REPO_ROOT

UTC = timezone.utc


def _at(month: int, day: int) -> datetime:
    return datetime(2026, month, day, 11, 59, 59, tzinfo=UTC)


# --- aliases ---------------------------------------------------------------


@pytest.fixture
def two_sources(make_conf):
    """The same conference under two spellings, one per upstream."""
    hf = make_conf.conference(
        key="kdd",
        title="KDD",
        sources=["aideadlines"],
        editions=[
            make_conf.edition(
                year=2026,
                edition_id="kdd26",
                source="aideadlines",
                deadlines=[make_conf.deadline("abstract", "abs", _at(2, 2), "AoE")],
            )
        ],
    )
    ccf = make_conf.conference(
        key="sigkdd",
        title="SIGKDD",
        upstream_sub="DB",
        rank={"ccf": "A"},
        sources=["ccfddl"],
        editions=[
            make_conf.edition(
                year=2026,
                edition_id="kdd26",
                source="ccfddl",
                deadlines=[make_conf.deadline("paper", "paper", _at(2, 9), "AoE")],
            )
        ],
    )
    return hf, ccf


def test_without_aliases_the_two_spellings_stay_apart(two_sources):
    from scripts.merge import merge_sources

    hf, ccf = two_sources
    merged = merge_sources([[hf], [ccf]], {})
    assert {c.key for c in merged} == {"kdd", "sigkdd"}


def test_aliases_merge_across_sources(two_sources):
    from scripts.merge import apply_aliases, merge_sources

    hf, ccf = two_sources
    groups = apply_aliases([[hf], [ccf]], {"kdd": "sigkdd"})
    merged = merge_sources(groups, {"source_priority": ["aideadlines", "ccfddl"]})

    assert [c.key for c in merged] == ["sigkdd"]
    conf = merged[0]
    assert set(conf.sources) == {"aideadlines", "ccfddl"}
    assert conf.rank.get("ccf") == "A", "the ranked upstream must not be lost"
    assert len(conf.editions) == 1
    kinds = {d.kind for d in conf.editions[0].deadlines}
    assert kinds == {"abstract", "paper"}, "both upstreams' deadlines survive"


def test_alias_table_does_not_touch_unrelated_keys(two_sources):
    from scripts.merge import apply_aliases

    hf, ccf = two_sources
    groups = apply_aliases([[hf], [ccf]], {"siggraph": "acm-siggraph"})
    assert [c.key for group in groups for c in group] == ["kdd", "sigkdd"]


def test_repository_alias_table_is_the_one_spec_records():
    """SPEC.md 3.1 lists the three pairs confirmed against real data."""
    overrides = yaml.safe_load(
        (REPO_ROOT / "data" / "overrides.yaml").read_text(encoding="utf-8")
    )
    aliases = (overrides or {}).get("aliases") or {}
    assert aliases.get("kdd") == "sigkdd"
    assert aliases.get("siggraph") == "acm-siggraph"
    assert aliases.get("cec") == "ieee-cec"


# --- collisions ------------------------------------------------------------


def test_same_slug_from_different_subfields_stays_two_conferences(make_conf):
    """Upstream really has two FSE (Fast Software Encryption / Foundations of SE)."""
    from scripts.merge import merge_sources

    def fse(sub, full_name):
        return make_conf.conference(
            key="fse",
            title="FSE",
            full_name=full_name,
            upstream_sub=sub,
            sources=["ccfddl"],
            editions=[
                make_conf.edition(
                    year=2026,
                    edition_id="fse26",
                    deadlines=[make_conf.deadline("paper", "p", _at(3, 1), "AoE")],
                )
            ],
        )

    merged = merge_sources(
        [[fse("SC", "Fast Software Encryption"), fse("SE", "Foundations of SE")]], {}
    )
    assert len(merged) == 2
    assert len({c.key for c in merged}) == 2, "the two FSE must not share a key"


def test_built_keys_are_unique(tmp_path, run_cli):
    outdir = tmp_path / "site"
    result = run_cli(outdir)
    assert result.returncode == 0, result.stderr
    data = json.loads((outdir / "data.json").read_text(encoding="utf-8"))
    keys = [c["key"] for c in data["conferences"]]
    assert len(keys) == len(set(keys))
