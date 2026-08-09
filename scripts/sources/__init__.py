"""Upstream data sources."""

from .aideadlines import AideadlinesSource
from .base import Source, fetch_tarball
from .ccfddl import CcfddlSource
from .local import LocalSource

__all__ = [
    "AideadlinesSource",
    "CcfddlSource",
    "LocalSource",
    "Source",
    "fetch_tarball",
]
