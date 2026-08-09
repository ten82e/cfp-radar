"""Entry point: python -m scripts.cli build [options]."""

from __future__ import annotations

import argparse
import importlib
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

import yaml

from .build import build_all
from .merge import (
    apply_aliases,
    apply_overrides,
    classify,
    dedup_deadlines,
    merge_sources,
    rollforward,
    sanitize_editions,
    select,
)
from .model import conferences_from_json, warning_counts

ROOT = Path(__file__).resolve().parent.parent
SOURCE_MODULES = ("ccfddl", "aideadlines", "local")


def parse_now(text: str | None) -> datetime:
    """Parse --now.  Accepts '2026-08-09T00:00:00Z' and plain ISO 8601."""
    if not text:
        return datetime.now(timezone.utc)
    value = text.strip()
    if value.endswith(("Z", "z")):
        value = value[:-1] + "+00:00"
    dt = datetime.fromisoformat(value)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _load_yaml(path: Path) -> dict:
    if not path.is_file():
        return {}
    return yaml.safe_load(path.read_text(encoding="utf-8")) or {}


def _instantiate_source(module_name: str):
    """Find the Source implementation in scripts.sources.<module_name>.

    The protocol is frozen in SPEC.md but the class name is not, so pick the
    module level SOURCE instance if present, else the class defined there that
    implements load().
    """
    mod = importlib.import_module(f".sources.{module_name}", package=__package__)
    obj = getattr(mod, "SOURCE", None)
    if obj is not None:
        return obj
    for value in vars(mod).values():
        if (
            isinstance(value, type)
            and getattr(value, "__module__", "") == mod.__name__
            and callable(getattr(value, "load", None))
        ):
            try:
                return value()
            except TypeError:
                return value(ROOT)
    raise RuntimeError(f"{mod.__name__} に Source 実装が見つからない")


def collect(cache_dir: Path, *, offline: bool) -> tuple[list[list], set[str]]:
    """Load every source.  Returns the groups and the names that came up empty.

    A source that raises, or that yields nothing at all, counts as failed: both
    upstreams always carry hundreds of conferences, so an empty result is a
    degradation and never a legitimate state.  ``local`` is exempt because
    ``data/extra.yaml`` may genuinely be empty.
    """
    groups: list[list] = []
    failed: set[str] = set()
    for name in SOURCE_MODULES:
        try:
            source = _instantiate_source(name)
            group = source.load(cache_dir, offline=offline)
        except Exception as exc:  # 1 源の障害で全体を落とさない
            print(f"warning: source {name} の取得に失敗した: {exc}", file=sys.stderr)
            group = []
        if not group and name != "local":
            failed.add(name)
        groups.append(group)
    return groups, failed


def _restore_snapshot(path: Path) -> list:
    if not path.is_file():
        return []
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        print(f"warning: {path} を読めない: {exc}", file=sys.stderr)
        return []
    return conferences_from_json(payload)


def cmd_build(args: argparse.Namespace) -> int:
    now = parse_now(args.now)
    config_path = Path(args.config)
    config = _load_yaml(config_path if config_path.is_absolute() else ROOT / config_path)
    overrides = _load_yaml(ROOT / "data" / "overrides.yaml")
    offline = bool(args.offline)

    snapshot = ROOT / "data" / "snapshot.json"

    groups, failed = collect(Path(args.cache), offline=offline)
    groups = apply_aliases(groups, overrides.get("aliases"))
    merge_stats: dict = {}
    confs = merge_sources(groups, config, merge_stats)
    confs = classify(confs, config)
    confs = apply_overrides(confs, overrides)
    confs = sanitize_editions(confs)
    confs = rollforward(confs, now.date(), config)
    # SPEC.md 3.6: roll-forward copies a real edition's deadlines into the
    # estimated one, so the fold runs once more behind it.
    confs = dedup_deadlines(confs, config, merge_stats)
    confs = select(confs, config)

    # SPEC.md section 3.5: an upstream outage must not gut the published site.
    # The snapshot is the finished pipeline output, so it is used as-is; when it
    # cannot cover the loss the run aborts rather than publishing a near-empty
    # calendar, which would delete events from every subscriber's calendar.
    degraded = bool(failed)
    if degraded:
        restored = _restore_snapshot(snapshot)
        if len(restored) > len(confs):
            print(
                f"warning: 上流 {','.join(sorted(failed))} が取得できないため "
                f"{snapshot} から {len(restored)} 会議で生成する",
                file=sys.stderr,
            )
            confs = restored
        else:
            print(
                f"error: 上流 {','.join(sorted(failed))} が取得できず、"
                f"退避に使える {snapshot} も無い（{len(confs)} 会議）。"
                "縮退した内容を配信しないため中断する",
                file=sys.stderr,
            )
            return 2

    outdir = Path(args.out)
    stats = build_all(confs, config, outdir, now)
    # 統合件数は出力に載った会議のぶんだけ数える。merge は select より前に走り、
    # 収録しない会議の統合まで混ぜると data.json と突き合わせられない。
    # snapshot から復旧した回は、その merge の結果を書いていないので 0。
    by_key = merge_stats.get("merged_by_key") or {}
    stats["merged"] = 0 if degraded else sum(by_key.get(c.key, 0) for c in confs)

    # 縮退したまま書き戻すと退避データそのものを壊すので、健全なときだけ更新する。
    # --offline の結果は上流の最新像ではない（キャッシュや tests/fixtures の縮小版
    # で走る）ので、退避データを上書きさせない。
    if not degraded and not offline and (outdir / "data.json").is_file():
        snapshot.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(outdir / "data.json", snapshot)

    print(
        "built {conferences} conferences / {editions} editions / "
        "{deadlines} deadlines / {events} events "
        "({estimated} estimated, {merged} merged) -> {out}".format(out=outdir, **stats)
    )
    # Surface parse/fetch soft-warnings so CI logs and operators can see
    # unparsable dates without grepping the whole run.  Counts are cumulative
    # for this process (sources + merge already ran above).
    counts = warning_counts()
    if counts:
        top = sorted(counts.items(), key=lambda item: (-item[1], item[0]))[:8]
        summary = "; ".join(f"{n}× {msg}" for msg, n in top)
        print(f"warnings: {sum(counts.values())} ({summary})", file=sys.stderr)
    return 0


def cmd_discover(args: argparse.Namespace) -> int:
    from .discover import NicheDiscoverer, format_discovered_yaml

    categories = [c.strip() for c in args.categories.split(",")] if args.categories else None
    discoverer = NicheDiscoverer(ROOT)
    print(f"Running niche venue & journal discovery (categories: {categories or 'all'})...")
    candidates = discoverer.run_discovery(categories=categories, min_year=args.min_year)

    print(f"Discovered {len(candidates)} new niche venue/journal candidates.")
    for cand in candidates[:10]:
        print(f"  - [{cand.key}] {cand.title}: {cand.full_name} ({cand.link})")

    yaml_text = format_discovered_yaml(candidates)

    if args.dry_run:
        print("\n--- Dry Run Output (extra.yaml format) ---")
        print(yaml_text[:1000] + ("..." if len(yaml_text) > 1000 else ""))
    elif args.out:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(yaml_text, encoding="utf-8")
        print(f"\nSaved candidates YAML to {out_path}")

    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m scripts.cli")
    sub = parser.add_subparsers(dest="command", required=True)

    build = sub.add_parser("build", help="収集して public/ を生成する")
    build.add_argument("--out", default="public", help="出力先ディレクトリ")
    build.add_argument("--config", default="config.yaml", help="設定ファイル")
    build.add_argument(
        "--offline", action="store_true", help="ネットワークを使わずキャッシュのみ使う"
    )
    build.add_argument(
        "--now", default=None, help="基準時刻。例 2026-08-09T00:00:00Z（既定は現在 UTC）"
    )
    build.add_argument("--cache", default=".cache", help="上流 tarball のキャッシュ先")
    build.set_defaults(func=cmd_build)

    discover = sub.add_parser("discover", help="穴場の会議・ジャーナルを自律探索する")
    discover.add_argument("--out", default=None, help="出力YAMLパス（未指定時は標準出力表示）")
    discover.add_argument("--categories", default=None, help="カンマ区切りの対象カテゴリ（例: hpc,systems）")
    discover.add_argument("--min-year", type=int, default=2026, help="対象の最小年")
    discover.add_argument("--dry-run", action="store_true", help="ファイル出力せず結果をプレビュー表示")
    discover.set_defaults(func=cmd_discover)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())

