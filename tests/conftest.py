"""Shared fixtures and helpers.

Everything here is derived from SPEC.md only. Implementation modules are imported
lazily inside fixtures so that a missing module fails the individual test rather
than the whole collection.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
FIXTURES = Path(__file__).resolve().parent / "fixtures"

if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

# Deterministic "now" used by every build in the test suite.
NOW = datetime(2026, 8, 9, 0, 0, 0, tzinfo=timezone.utc)
NOW_ARG = "2026-08-09T00:00:00Z"

# public/ contents required by SPEC.md section 4.
PUBLIC_FILES = [
    "index.html",
    "all.ics",
    "hpc.ics",
    "networking.ics",
    "systems.ics",
    "ai.ics",
    "security.ics",
    "deadlines.ics",
    "all-estimated.ics",
    "hpc-estimated.ics",
    "networking-estimated.ics",
    "systems-estimated.ics",
    "ai-estimated.ics",
    "security-estimated.ics",
    "data.json",
    "data.csv",
    "upcoming.md",
    "llms.txt",
    ".nojekyll",
]

# SPEC.md pins fetch_tarball()'s contract (return the extracted root) but not the
# name of the cache slot it uses, so the fixture data is materialised under every
# plausible slot name. Each slot holds one top-level directory, mirroring what a
# codeload tarball extracts to.
_REPOS = [
    ("ccfddl/ccf-deadlines", "ccf-deadlines-main", "ccfddl", "conference"),
    ("huggingface/ai-deadlines", "ai-deadlines-main", "aideadlines", "src"),
]
_REF = "main"


def _slot_names(repo: str) -> list[str]:
    short = repo.split("/")[-1]
    return [
        f"{repo.replace('/', '__')}__{_REF}",
        f"{repo.replace('/', '-')}-{_REF}",
        f"{short}-{_REF}",
        f"{repo.replace('/', '_')}_{_REF}",
    ]


def _populate_cache(cache_dir: Path) -> Path:
    cache_dir.mkdir(parents=True, exist_ok=True)
    for repo, top, fixture_dir, payload in _REPOS:
        for slot in _slot_names(repo):
            dest = cache_dir / slot / top / payload
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(FIXTURES / fixture_dir / payload, dest, dirs_exist_ok=True)
    return cache_dir


@pytest.fixture(scope="session")
def fixture_cache(tmp_path_factory) -> Path:
    """An offline cache directory whose only data source is tests/fixtures/."""
    return _populate_cache(tmp_path_factory.mktemp("cache"))


@pytest.fixture(scope="session")
def repo_config() -> dict:
    """The project's real config.yaml (owned by another author; skip if absent)."""
    import yaml

    path = REPO_ROOT / "config.yaml"
    if not path.exists():
        pytest.skip("config.yaml not present yet")
    with path.open(encoding="utf-8") as fh:
        return yaml.safe_load(fh) or {}


@pytest.fixture(scope="session")
def run_cli(fixture_cache):
    """Run `python -m scripts.cli build` offline against the fixture cache."""

    def _run(outdir: Path, *, now: str = NOW_ARG, extra: list[str] | None = None):
        cmd = [
            sys.executable,
            "-m",
            "scripts.cli",
            "build",
            "--out",
            str(outdir),
            "--offline",
            "--cache",
            str(fixture_cache),
            "--now",
            now,
        ]
        cmd += list(extra or [])
        return subprocess.run(
            cmd, cwd=str(REPO_ROOT), capture_output=True, text=True, timeout=300
        )

    return _run


@pytest.fixture
def make_conf():
    """Factory for hand-built Conference objects (SPEC.md section 3 dataclasses)."""
    from scripts.model import Conference, Deadline, Edition

    def _deadline(kind, label, at_utc, tz_raw="AoE", round=1, comment=None):
        return Deadline(
            kind=kind,
            label=label,
            at_utc=at_utc,
            tz_raw=tz_raw,
            round=round,
            comment=comment,
        )

    def _edition(**kw):
        kw.setdefault("link", "https://example.org/")
        kw.setdefault("place", "Somewhere")
        kw.setdefault("date_text", "")
        kw.setdefault("event_start", None)
        kw.setdefault("event_end", None)
        kw.setdefault("deadlines", [])
        kw.setdefault("estimated", False)
        kw.setdefault("source", "ccfddl")
        return Edition(**kw)

    def _conference(**kw):
        kw.setdefault("full_name", kw.get("title", ""))
        kw.setdefault("link", "https://example.org/")
        kw.setdefault("rank", {})
        kw.setdefault("editions", [])
        kw.setdefault("sources", ["ccfddl"])
        return Conference(**kw)

    class _Factory:
        conference = staticmethod(_conference)
        edition = staticmethod(_edition)
        deadline = staticmethod(_deadline)

    return _Factory


# --- ICS helpers -----------------------------------------------------------


def ics_physical_lines(raw: bytes) -> list[bytes]:
    """Split an ICS byte string into physical lines on CRLF."""
    body = raw
    if body.endswith(b"\r\n"):
        body = body[:-2]
    return body.split(b"\r\n")


def unfold_ics(text: str) -> list[str]:
    """RFC 5545 unfolding: a CRLF followed by a single space/tab is removed."""
    return text.replace("\r\n ", "").replace("\r\n\t", "").split("\r\n")


def ics_property(lines: list[str], name: str) -> list[str]:
    """Values of every occurrence of a property (unfolded lines expected)."""
    out = []
    for line in lines:
        if line.startswith(name + ":") or line.startswith(name + ";"):
            out.append(line.split(":", 1)[1] if ":" in line else "")
    return out


def vevent_blocks(lines: list[str]) -> list[list[str]]:
    blocks, current = [], None
    for line in lines:
        if line == "BEGIN:VEVENT":
            current = []
        elif line == "END:VEVENT":
            if current is not None:
                blocks.append(current)
            current = None
        elif current is not None:
            current.append(line)
    return blocks
