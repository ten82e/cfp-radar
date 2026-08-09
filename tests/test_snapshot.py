"""Snapshot fallback: SPEC.md section 3.5.

Two branches matter.  With a usable ``data/snapshot.json`` an upstream outage
must keep producing the full site; without one the run must fail loudly instead
of publishing a near-empty calendar (subscribers' calendars delete whatever the
feed stops listing).
"""

from __future__ import annotations

import argparse
import json
import shutil

import pytest

from .conftest import NOW_ARG, REPO_ROOT


@pytest.fixture
def isolated_repo(tmp_path, monkeypatch):
    """A ROOT that has the real config but its own data/ directory."""
    from scripts import cli

    root = tmp_path / "repo"
    (root / "data").mkdir(parents=True)
    shutil.copy(REPO_ROOT / "config.yaml", root / "config.yaml")
    shutil.copy(REPO_ROOT / "data" / "overrides.yaml", root / "data" / "overrides.yaml")
    monkeypatch.setattr(cli, "ROOT", root)
    return root


def _args(root, outdir, cache=None):
    return argparse.Namespace(
        out=str(outdir),
        config="config.yaml",
        offline=True,
        now=NOW_ARG,
        cache=str(cache or root / ".cache"),
    )


def _all_upstreams_down(monkeypatch):
    from scripts import cli

    monkeypatch.setattr(
        cli, "collect", lambda cache_dir, *, offline: ([[], [], []], {"ccfddl", "aideadlines"})
    )


def test_build_recovers_from_the_snapshot_when_every_source_fails(
    tmp_path, isolated_repo, monkeypatch, capsys
):
    from scripts import cli

    snapshot = json.loads(
        (REPO_ROOT / "data" / "snapshot.json").read_text(encoding="utf-8")
    )
    assert len(snapshot["conferences"]) > 100, "the committed snapshot is not usable"
    (isolated_repo / "data" / "snapshot.json").write_text(
        json.dumps(snapshot, ensure_ascii=False), encoding="utf-8"
    )

    _all_upstreams_down(monkeypatch)
    outdir = tmp_path / "out"
    assert cli.cmd_build(_args(isolated_repo, outdir)) == 0

    data = json.loads((outdir / "data.json").read_text(encoding="utf-8"))
    assert len(data["conferences"]) == len(snapshot["conferences"])
    assert "取得できないため" in capsys.readouterr().err


def test_build_aborts_instead_of_publishing_a_gutted_calendar(
    tmp_path, isolated_repo, monkeypatch, capsys
):
    """No snapshot to fall back on: publishing what is left would delete events."""
    from scripts import cli

    _all_upstreams_down(monkeypatch)
    outdir = tmp_path / "out"
    assert cli.cmd_build(_args(isolated_repo, outdir)) != 0
    assert not (outdir / "all.ics").exists(), "nothing may be written on abort"
    assert "中断する" in capsys.readouterr().err


def test_an_offline_build_does_not_overwrite_the_snapshot(
    tmp_path, isolated_repo, fixture_cache
):
    """--offline builds run off a cache (in CI, tests/fixtures' reduced copy).

    Letting one write the snapshot replaces the retreat copy with a handful of
    conferences, which is exactly what the snapshot exists to prevent.
    """
    from scripts import cli

    kept = {"conferences": [{"key": "sentinel", "editions": []}]}
    target = isolated_repo / "data" / "snapshot.json"
    target.write_text(json.dumps(kept), encoding="utf-8")

    outdir = tmp_path / "out"
    assert cli.cmd_build(_args(isolated_repo, outdir, cache=fixture_cache)) == 0
    assert json.loads(target.read_text(encoding="utf-8")) == kept

    # ...and the real repository's snapshot is untouched by the test suite.
    live = json.loads(
        (REPO_ROOT / "data" / "snapshot.json").read_text(encoding="utf-8")
    )
    assert len(live["conferences"]) > 100
