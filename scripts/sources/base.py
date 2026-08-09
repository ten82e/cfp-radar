"""Source protocol and tarball fetching (urllib only, no third-party HTTP)."""

from __future__ import annotations

import shutil
import tarfile
import tempfile
import urllib.request
from pathlib import Path
from typing import Protocol

from ..model import Conference, warn

USER_AGENT = "conf-deadlines/1.0 (+https://github.com/ccfddl; python-urllib)"
CODELOAD = "https://codeload.github.com/{repo}/tar.gz/refs/heads/{ref}"


class Source(Protocol):
    name: str

    def load(
        self, cache_dir: Path, *, offline: bool = False
    ) -> list[Conference]: ...


def _cache_slot(cache_dir: Path, repo: str, ref: str) -> Path:
    return Path(cache_dir) / (repo.replace("/", "__") + "__" + ref)


def _extracted_root(slot: Path) -> Path | None:
    """The single top-level directory inside an extracted tarball."""
    if not slot.is_dir():
        return None
    children = [p for p in slot.iterdir() if p.is_dir()]
    return children[0] if len(children) == 1 else None


def fetch_tarball(
    repo: str, ref: str, cache_dir: Path, *, offline: bool = False
) -> Path:
    """Download and extract ``repo`` at ``ref``; return the extracted root.

    ``offline=True`` uses the cache only and raises FileNotFoundError when it is
    missing.  A network failure falls back to an existing cache with a warning,
    and only raises when there is nothing cached.
    """
    cache_dir = Path(cache_dir)
    slot = _cache_slot(cache_dir, repo, ref)
    cached = _extracted_root(slot)

    if offline:
        if cached is None:
            raise FileNotFoundError(
                f"no cached copy of {repo}@{ref} under {cache_dir}"
            )
        return cached

    cache_dir.mkdir(parents=True, exist_ok=True)
    url = CODELOAD.format(repo=repo, ref=ref)
    try:
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with tempfile.TemporaryDirectory(dir=cache_dir) as tmp:
            archive = Path(tmp) / "archive.tar.gz"
            with urllib.request.urlopen(request, timeout=60) as response:
                with open(archive, "wb") as out:
                    shutil.copyfileobj(response, out)
            staging = Path(tmp) / "x"
            staging.mkdir()
            with tarfile.open(archive, "r:gz") as tar:
                tar.extractall(staging, filter="data")
            if _extracted_root(staging) is None:
                raise ValueError(f"unexpected tarball layout for {repo}@{ref}")
            if slot.exists():
                shutil.rmtree(slot)
            shutil.move(str(staging), str(slot))
    except Exception as exc:  # network, HTTP, tar, disk
        if cached is not None:
            warn(f"fetch of {repo}@{ref} failed ({exc}); using cached copy")
            return cached
        raise

    root = _extracted_root(slot)
    if root is None:
        raise ValueError(f"unexpected tarball layout for {repo}@{ref}")
    return root
