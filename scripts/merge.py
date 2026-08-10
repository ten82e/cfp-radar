"""Name matching, classification, overrides, roll-forward and selection.

Consumes the frozen interface of ``scripts.model`` (SPEC.md section 3) only.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import replace
from datetime import date, datetime, timedelta
from statistics import median
from typing import NamedTuple

from .model import Conference, Deadline, Edition
from .sources.local import _deadlines_of

DEFAULT_SOURCE_PRIORITY = ["local", "aideadlines", "ccfddl"]
# SPEC.md 3.6.  Two deadlines of the same kind in the same edition that come
# from *different* sources are folded under one of two rules.  When each source
# holds exactly one such deadline they are the same deadline by construction and
# only the runaway guard applies; otherwise the sources enumerate several real
# deadlines and only near-coincidence identifies a pair.  Deadlines from the
# same source need an exact match instead, so neither window applies to them.
DEFAULT_ONE_TO_ONE_MAX_S = 604800  # 7 d
DEFAULT_CROSS_SOURCE_TOLERANCE_S = 90000  # 25 h
_ABSENT_RANKS = {"N", "-", "none", "None"}


class _Windows(NamedTuple):
    """How far apart two cross-source records of one deadline may be."""

    one_to_one: int
    cross_source: int


# --------------------------------------------------------------------------
# merge
# --------------------------------------------------------------------------

def apply_aliases(
    groups: list[list[Conference]], aliases: dict | None
) -> list[list[Conference]]:
    """Rewrite conference keys before name matching (SPEC.md 3.1).

    The two upstreams spell some conferences differently ('KDD' vs 'SIGKDD'),
    which ``slug(title)`` cannot reconcile.  ``data/overrides.yaml`` maps the
    alias onto the canonical key so that ``merge_sources`` sees one conference.
    """
    if not aliases:
        return groups
    table = {str(k): str(v) for k, v in aliases.items()}
    return [
        [replace(conf, key=table.get(conf.key, conf.key)) for conf in group]
        for group in groups
    ]


def merge_sources(
    groups: list[list[Conference]], config: dict, stats: dict | None = None
) -> list[Conference]:
    """Merge per-source conference lists into one list keyed by ``Conference.key``.

    Conferences sharing a key but belonging to different upstream sub-fields are
    *not* the same conference (upstream really has two ``FSE`` and two ``SEC``).
    Such collisions are split into separate conferences; the bucket whose
    ``upstream_sub`` sorts first keeps the plain key, the others get a
    ``<key>-<sub-lowercased>`` key.

    ``stats`` is an optional out-parameter; it receives ``merged_deadlines``
    (near-duplicates folded away, SPEC.md 3.6) and ``merged_by_key``, the same
    count per conference key so the caller can restrict it to what ``select``
    actually publishes.
    """
    priority = config.get("source_priority") or DEFAULT_SOURCE_PRIORITY
    windows = _windows(config)
    tally: dict = {"merged_deadlines": 0, "merged_by_key": {}}

    ordered: list[tuple[int, int, Conference]] = []
    for group in groups:
        for conf in group:
            ordered.append((_priority_of(conf, priority), len(ordered), conf))
    ordered.sort(key=lambda item: (item[0], item[1]))

    buckets: dict[str, list[list[Conference]]] = {}
    for _, _, conf in ordered:
        bucket_list = buckets.setdefault(conf.key, [])
        for bucket in bucket_list:
            if _same_conference(bucket, conf):
                bucket.append(conf)
                break
        else:
            bucket_list.append([conf])

    merged: list[Conference] = []
    for key, bucket_list in buckets.items():
        if len(bucket_list) == 1:
            merged.append(_merge_bucket(key, bucket_list[0], windows, tally))
            continue
        bucket_list.sort(key=lambda b: (b[0].upstream_sub or ""))
        for index, bucket in enumerate(bucket_list):
            suffix = (bucket[0].upstream_sub or str(index)).lower()
            merged.append(
                _merge_bucket(
                    key if index == 0 else f"{key}-{suffix}", bucket, windows, tally
                )
            )

    merged.sort(key=lambda c: c.key)
    if stats is not None:
        stats.update(tally)
    return merged


def _windows(config: dict) -> _Windows:
    return _Windows(
        one_to_one=int(
            config.get(
                "deadline_merge_one_to_one_max_seconds", DEFAULT_ONE_TO_ONE_MAX_S
            )
        ),
        cross_source=int(
            config.get(
                "deadline_merge_cross_source_seconds", DEFAULT_CROSS_SOURCE_TOLERANCE_S
            )
        ),
    )


def _priority_of(conf: Conference, priority: list[str]) -> int:
    for name in conf.sources:
        if name in priority:
            return priority.index(name)
    return len(priority)


def _same_conference(bucket: list[Conference], conf: Conference) -> bool:
    for existing in bucket:
        if existing.upstream_sub and conf.upstream_sub:
            return existing.upstream_sub == conf.upstream_sub
    return True


def _merge_bucket(
    key: str, confs: list[Conference], windows: _Windows, tally: dict
) -> Conference:
    """``confs`` is ordered high priority first."""
    out = Conference(key=key, title=confs[0].title, full_name=confs[0].full_name,
                     link=confs[0].link)
    for conf in reversed(confs):  # low priority first, higher priority overwrites
        for field in ("title", "full_name", "link"):
            value = getattr(conf, field)
            if value:
                setattr(out, field, value)
        if conf.rank:
            out.rank.update(conf.rank)
        if conf.dblp:
            out.dblp = conf.dblp
        if conf.upstream_sub:
            out.upstream_sub = conf.upstream_sub
    out.tags = _unique(t for conf in confs for t in conf.tags)
    out.categories = _unique(c for conf in confs for c in conf.categories)
    out.sources = _unique(s for conf in confs for s in conf.sources)
    before = tally["merged_deadlines"]
    out.editions = _merge_editions(confs, windows, tally)
    merged_here = tally["merged_deadlines"] - before
    if merged_here:
        tally["merged_by_key"][key] = merged_here
    return out


def _merge_editions(
    confs: list[Conference], windows: _Windows, tally: dict
) -> list[Edition]:
    """Merge the editions of one conference, keeping deadline provenance.

    ``Deadline`` carries no source of its own, but SPEC.md 3.6 needs it: the
    rule that folds two records is a different one depending on whether they
    come from the same upstream.  The provenance is therefore carried alongside
    the deadline until ``_dedup_deadlines`` has consumed it.
    """
    by_year: dict[int, list[tuple[Edition, list[tuple[str, Deadline]]]]] = {}
    for conf in confs:  # high priority first
        for edition in conf.editions:
            bucket = by_year.setdefault(edition.year, [])
            index = _merge_target([held for held, _ in bucket], edition)
            tagged = [(edition.source, d) for d in edition.deadlines]
            if index is None:
                bucket.append((replace(edition, deadlines=[]), tagged))
                continue
            held = bucket[index][0]
            if held.estimated and not edition.estimated:
                # SPEC.md 3.6: a real edition replaces an estimated one for the
                # same year.  The estimate's deadlines are a copy of last
                # year's, so they must not stand beside the real ones; the real
                # edition takes the seat wholesale.
                bucket[index] = (replace(edition, deadlines=[]), tagged)
            elif edition.estimated and not held.estimated:
                # An estimate joining a real edition contributes nothing: its
                # deadlines are last year's copy and its metadata may be stale.
                continue
            else:
                _fill_edition(held, edition)
                bucket[index][1].extend(tagged)
    out: list[Edition] = []
    for year in sorted(by_year):
        for edition, tagged in sorted(by_year[year], key=lambda item: item[0].edition_id):
            # Deduplicate after every source has contributed, because
            # near-duplicates also occur *inside* one upstream (GECCO files two
            # tracks under one instant with the same label).
            edition.deadlines = _dedup_deadlines(tagged, windows, tally)
            out.append(edition)
    return out


def _merge_target(bucket: list[Edition], edition: Edition) -> int | None:
    """Index of the edition already held for this year that ``edition`` joins.

    Same year normally means the same edition even when the sources spell the
    id differently (``nips25`` vs ``neurips25``), so an entry from a *different*
    source is a merge target.  A source that itself lists several meetings in
    one year (the domestic SIG workshops in ``data/extra.yaml``) really has two
    editions, so entries from the *same* source with different ids stay apart.
    """
    for index, candidate in enumerate(bucket):
        if candidate.edition_id == edition.edition_id:
            return index
    for index, candidate in enumerate(bucket):
        if candidate.source != edition.source:
            return index
    return None


def _fill_edition(target: Edition, other: Edition) -> None:
    for field in ("edition_id", "link", "place", "date_text", "event_start", "event_end"):
        if not getattr(target, field) and getattr(other, field):
            setattr(target, field, getattr(other, field))


def _norm_label(label: str | None) -> str:
    """Label form used for equality: case and whitespace carry no meaning."""
    return " ".join((label or "").split()).casefold()


def dedup_deadlines(
    confs: list[Conference], config: dict, stats: dict | None = None
) -> list[Conference]:
    """Re-apply the SPEC.md 3.6 fold after roll-forward.

    ``rollforward`` copies the last real edition's deadlines into an estimated
    edition, so any duplicate left standing upstream of it is duplicated again.
    A merged edition no longer knows which upstream each deadline came from, so
    only the same-source rule (identical instant *and* label) can be applied
    here; the cross-source window has already done its work in ``merge_sources``
    and must not be re-run blind, or SIGGRAPH's separate tracks would collapse.
    """
    windows = _windows(config)
    tally: dict = {"merged_deadlines": 0, "merged_by_key": {}}
    out: list[Conference] = []
    for conf in confs:
        editions = []
        for edition in conf.editions:
            before = tally["merged_deadlines"]
            tagged = [(edition.source, d) for d in edition.deadlines]
            editions.append(
                replace(edition, deadlines=_dedup_deadlines(tagged, windows, tally))
            )
            folded = tally["merged_deadlines"] - before
            if folded:
                tally["merged_by_key"][conf.key] = (
                    tally["merged_by_key"].get(conf.key, 0) + folded
                )
        out.append(replace(conf, editions=editions))
    if stats is not None:
        stats["merged_deadlines"] = (
            stats.get("merged_deadlines", 0) + tally["merged_deadlines"]
        )
        by_key = stats.setdefault("merged_by_key", {})
        for key, count in tally["merged_by_key"].items():
            by_key[key] = by_key.get(key, 0) + count
    return out


def _dedup_deadlines(
    tagged: list[tuple[str, Deadline]], windows: _Windows, tally: dict
) -> list[Deadline]:
    """Fold deadlines of one edition that are the same deadline seen twice.

    SPEC.md 3.6.  Three rules, because the failure modes are different:

    * **different sources, one record each** — if source X holds exactly one
      deadline of this kind for this edition and source Y also holds exactly
      one, the two are the same deadline: two documents transcribing one field,
      disagreeing about the timezone it was written in or about the day itself.
      Were they two real deadlines, one of the sources would list both.  The
      window here is only a runaway guard (``windows.one_to_one``).
    * **different sources, several records** — the sources enumerate distinct
      deadlines (SIGGRAPH's dozen submission tracks against ccfddl's single
      'Paper submission'), so pairing them needs near-coincidence in time:
      anything of the same kind within ``windows.cross_source``.
    * **same source** — only an identical instant *and* an identical normalised
      label is one deadline.  One upstream really does file several tracks under
      one instant (SIGGRAPH 2026 has three at 2026-04-21T22:00:00Z), and folding
      those loses real deadlines.

    ``tagged`` arrives highest source priority first, so the first entry wins
    its value, label, comment and link.  When the match crosses sources the
    ``round`` is the larger of the two: ai-deadlines has no notion of rounds and
    reports 1 for every deadline, which used to demote ccfddl's round 2 (WACV
    2027 rendered an abstract of round 2 next to a paper of round 1).  Within
    one source the rounds are comparable, so the winner keeps its own.

    The loser's wording is preserved in ``comment`` rather than discarded.
    """
    held_per_source: Counter = Counter((source, d.kind) for source, d in tagged)
    kept: list[tuple[set[str], Deadline]] = []
    for source, deadline in tagged:
        best: tuple[float, int] | None = None
        for index, (origins, held) in enumerate(kept):
            if held.kind != deadline.kind:
                continue
            gap = abs((held.at_utc - deadline.at_utc).total_seconds())
            if source in origins:
                if gap or _norm_label(held.label) != _norm_label(deadline.label):
                    continue
            else:
                one_to_one = all(
                    held_per_source[(name, deadline.kind)] == 1
                    for name in (origins | {source})
                )
                limit = windows.one_to_one if one_to_one else windows.cross_source
                if gap > limit:
                    continue
            # Nearest wins, not first: SIGGRAPH files 'Technical Papers' and
            # 'Upload and conflicts' 24 h apart and ccfddl's 'Paper submission'
            # is within the window of both.  It belongs to the exact match.
            if best is None or gap < best[0]:
                best = (gap, index)
        if best is None:
            kept.append(({source}, deadline))
            continue
        origins, held = kept[best[1]]
        kept[best[1]] = (origins | {source}, _absorb(held, deadline, source in origins))
        tally["merged_deadlines"] += 1
    out = [deadline for _, deadline in kept]
    out.sort(key=lambda d: (d.round, d.at_utc, d.kind, d.label or ""))
    return out


def _absorb(winner: Deadline, loser: Deadline, same_source: bool) -> Deadline:
    notes = [winner.comment] if winner.comment else []
    if loser.comment and loser.comment not in notes:
        notes.append(loser.comment)
    if loser.label and loser.label != winner.label:
        # Only a fold of two records of the *same* instant is "同時刻"; the
        # cross-source rules also fold records that are hours or days apart.
        same_instant = winner.at_utc == loser.at_utc
        note = f"{'同時刻の' if same_instant else ''}別記載: {loser.label}"
        if note not in notes:
            notes.append(note)
    comment = " / ".join(notes) or None
    round_ = winner.round if same_source else max(winner.round, loser.round)
    if comment == winner.comment and round_ == winner.round:
        return winner
    return replace(winner, comment=comment, round=round_)


def _unique(values) -> list:
    out: list = []
    for value in values:
        if value and value not in out:
            out.append(value)
    return out


# --------------------------------------------------------------------------
# classify
# --------------------------------------------------------------------------

def classify(confs: list[Conference], config: dict) -> list[Conference]:
    taxonomy = config.get("taxonomy") or {}
    known = set(config.get("categories") or taxonomy)
    excluded = set(config.get("exclude") or [])
    out = []
    for conf in confs:
        if conf.key in excluded:
            categories: list[str] = []
        else:
            categories = list(conf.categories)
            for name, rule in taxonomy.items():
                if name not in categories and _matches(conf, rule or {}):
                    categories.append(name)
            categories = [c for c in categories if not known or c in known]
        out.append(replace(conf, categories=categories))
    return out


def _matches(conf: Conference, rule: dict) -> bool:
    if conf.key in (rule.get("venues") or []):
        return True
    subs = rule.get("ccfddl_subs") or []
    if conf.upstream_sub and conf.upstream_sub in subs:
        return True
    sources = rule.get("sources") or []
    return bool(sources) and any(s in sources for s in conf.sources)


# --------------------------------------------------------------------------
# overrides
# --------------------------------------------------------------------------

def apply_overrides(confs: list[Conference], overrides: dict) -> list[Conference]:
    overrides = overrides or {}
    dropped = set(overrides.get("drop") or [])
    patches = overrides.get("conferences") or {}
    out = []
    for conf in confs:
        if conf.key in dropped:
            continue
        patch = patches.get(conf.key)
        if not patch:
            out.append(conf)
            continue
        conf = replace(conf, editions=list(conf.editions))
        for field in ("title", "full_name", "link", "dblp", "upstream_sub"):
            if field in patch:
                setattr(conf, field, patch[field])
        if "rank" in patch:
            conf.rank = {**conf.rank, **(patch["rank"] or {})}
        for field in ("tags", "categories"):
            if field in patch:
                setattr(conf, field, list(patch[field] or []))
        edition_patches = patch.get("editions") or {}
        if edition_patches:
            conf.editions = _patch_editions(conf.editions, edition_patches)
        out.append(conf)
    return out


def sanitize_editions(confs: list[Conference]) -> list[Conference]:
    """Drop paper/abstract deadlines that fall after the meeting ends.

    Cross-source merges and HF typos can attach next year's submission to this
    year's edition (ICASSP 2025 carried the 2026 paper date).  A submission
    deadline after ``event_end`` is almost never real; camera-ready and other
    kinds are left alone because some venues post them during the meeting.
    """
    out: list[Conference] = []
    for conf in confs:
        editions = [_sanitize_edition(ed) for ed in conf.editions]
        out.append(replace(conf, editions=editions))
    return out


def _sanitize_edition(edition: Edition) -> Edition:
    if edition.event_end is None or not edition.deadlines:
        return edition
    kept = [
        d
        for d in edition.deadlines
        if d.kind not in ("paper", "abstract") or d.at_utc.date() <= edition.event_end
    ]
    if len(kept) == len(edition.deadlines):
        return edition
    return replace(edition, deadlines=kept)


def _patch_editions(editions: list[Edition], patches: dict) -> list[Edition]:
    kept = []
    for edition in editions:
        patch = patches.get(edition.year)
        if patch is None:
            kept.append(edition)
            continue
        if patch.get("drop"):
            continue
        edition = replace(edition, deadlines=list(edition.deadlines))
        for field in ("link", "place", "date_text"):
            if field in patch:
                setattr(edition, field, patch[field])
        for field in ("event_start", "event_end"):
            if field in patch:
                setattr(edition, field, _as_date(patch[field]))
        if "deadlines" in patch:
            # 置換 (延長・訂正): 上流の古い締切を残さず差し替える。extra.yaml と
            # 同じ形式 (kind/label/date/tz) で書く (SPEC.md 3.5)。
            edition = replace(
                edition, deadlines=_deadlines_of({"deadlines": patch["deadlines"]})
            )
        kept.append(edition)
    return kept


def _as_date(value) -> date | None:
    if value is None or isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, datetime):
        return value.date()
    try:
        return date.fromisoformat(str(value))
    except ValueError:
        return None


# --------------------------------------------------------------------------
# roll-forward
# --------------------------------------------------------------------------

def rollforward(confs: list[Conference], today: date, config: dict) -> list[Conference]:
    cfg = config.get("rollforward") or {}
    if not cfg.get("enabled", True):
        return list(confs)
    kinds = set(cfg.get("kinds") or ["abstract", "paper"])
    default_interval = int(cfg.get("default_interval_days", 364))
    lookback = int(cfg.get("interval_lookback_editions", 3))
    max_stale = int(cfg.get("max_stale_days", 730))

    out = []
    for conf in confs:
        estimated = _estimate_edition(conf, today, kinds, default_interval, lookback, max_stale)
        out.append(replace(conf, editions=list(conf.editions) + [estimated])
                   if estimated else conf)
    return out


def _estimate_edition(conf, today, kinds, default_interval, lookback, max_stale):
    if any(_is_future(edition, today) for edition in conf.editions):
        return None
    dated = [(e, _paper_at(e)) for e in sorted(conf.editions, key=lambda e: e.year)
             if not e.estimated]
    dated = [(e, at) for e, at in dated if at is not None]
    if not dated:
        return None

    last, last_at = dated[-1]
    stale = (today - last_at.date()).days
    if stale < 0 or stale > max_stale:
        return None

    interval = _interval_days([at for _, at in dated[-lookback:]], default_interval)
    # One interval can still land in the past when upstream's newest record is a year
    # or more old (biennial venues, lagging upstream). Advance by whole intervals so the
    # weekday is preserved, and give up rather than emit an estimate that is already past.
    steps = 1
    while steps < 3 and (last_at + timedelta(days=interval * steps)).date() < today:
        steps += 1
    shift = interval * steps
    if (last_at + timedelta(days=shift)).date() < today:
        return None
    # Derive the year label from the shift actually applied, not from the
    # interval alone: when a venue changes its round layout the estimated
    # interval is a fraction of a year, and multiplying the year by `steps`
    # detaches the label from the dates it carries (SAC: a 2028 edition holding
    # a 2026-08 deadline).
    year = last.year + max(1, round(shift / 365.25))
    if any(e.year == year and not e.estimated for e in conf.editions):
        return None  # upstream already lists that edition, it just has no dates yet

    deadlines = [
        Deadline(kind=d.kind, label=d.label, at_utc=d.at_utc + timedelta(days=shift),
                 tz_raw=d.tz_raw, round=d.round,
                 comment=f"Estimated from the {last.year} edition")
        for d in last.deadlines if d.kind in kinds
    ]
    if not deadlines:
        return None
    return Edition(year=year, edition_id=f"{conf.key}{year % 100:02d}-est", link=last.link,
                   place="", date_text="", event_start=None, event_end=None,
                   deadlines=deadlines, estimated=True, source=last.source)


def _is_future(edition: Edition, today: date) -> bool:
    """True when this edition still has something ahead of ``today``.

    A future paper deadline is enough.  So is a future meeting date: once the
    papers are closed the conference may still be months away, and inventing
    the next edition then floods the calendar with premature estimates (IMC
    2026 → bogus IMC 2027 in August while Karlsruhe had not met).
    """
    if any(d.at_utc.date() >= today for d in edition.deadlines if d.kind == "paper"):
        return True
    return any(
        day is not None and day >= today
        for day in (edition.event_start, edition.event_end)
    )


def _paper_at(edition: Edition) -> datetime | None:
    papers = [d.at_utc for d in edition.deadlines if d.kind == "paper"]
    return min(papers) if papers else None


def _interval_days(instants: list[datetime], default: int) -> int:
    gaps = [(b - a).days for a, b in zip(instants, instants[1:])]
    if not gaps:
        return default
    estimate = round(median(gaps) / 7) * 7  # multiples of 7 preserve the weekday
    return estimate if 180 <= estimate <= 900 else default


# --------------------------------------------------------------------------
# select
# --------------------------------------------------------------------------

def select(confs: list[Conference], config: dict) -> list[Conference]:
    enabled = set(config.get("categories") or {})
    excluded = set(config.get("exclude") or [])
    rank_filter = config.get("rank_filter") or {}
    always_keep = set(rank_filter.get("always_keep") or [])
    # Venues named under taxonomy are intentional inclusions.  Rank must not
    # veto them: otherwise listing e.g. systor / sec under systems.venues is a
    # no-op once ccf is C (real gap found 2026-08-09: 14 named venues dropped).
    for rule in (config.get("taxonomy") or {}).values():
        if isinstance(rule, dict):
            always_keep.update(rule.get("venues") or [])
    keep_if_no_rank = bool(rank_filter.get("keep_if_no_rank", True))
    schemes = {name: allowed for name, allowed in rank_filter.items()
               if name not in ("keep_if_no_rank", "always_keep") and allowed}

    out = []
    for conf in confs:
        if conf.key in excluded:
            continue
        categories = [c for c in conf.categories if not enabled or c in enabled]
        if not categories:
            continue
        if conf.key not in always_keep and not _rank_ok(conf, schemes, keep_if_no_rank):
            continue
        # ジャーナル（tags: [journal]）は特集号 CFP の締切が出るまで日付を持たないが、
        # 「index されている」ことが価値なので日付なしでも残す。
        if not _has_dates(conf) and "journal" not in (conf.tags or []):
            continue
        out.append(replace(conf, categories=categories))
    return out


def _has_dates(conf: Conference) -> bool:
    """A conference with neither a deadline nor a meeting date renders nothing.

    Every output (ICS, CSV, upcoming.md, the site table) is keyed on a date, so
    such a conference is invisible everywhere and only inflates the counts.
    """
    return any(ed.deadlines or ed.event_start for ed in conf.editions)


def _rank_ok(conf: Conference, schemes: dict, keep_if_no_rank: bool) -> bool:
    if not schemes:
        return True
    has_rank = False
    for scheme, allowed in schemes.items():
        value = (conf.rank or {}).get(scheme)
        if not value or value in _ABSENT_RANKS:
            continue
        has_rank = True
        if value in allowed:
            return True
    return keep_if_no_rank and not has_rank
