#!/usr/bin/env python3
"""候補レビュー支援: レビュー優先順位 (締切昇順)・重複グループ・predatory 疑い・過去締切を一覧する。

使い方: python -m scripts.review_candidates [--limit 60]
出力はレビュー時の判断材料で、収録 (extra.yaml 昇格) は公式サイト裏取り後に人間が行う。
"""
import argparse
import re
from collections import defaultdict
from datetime import date
from pathlib import Path

import yaml

from scripts.discover import _parse_deadline

ROOT = Path(__file__).resolve().parent.parent

# 名乗りベースの危険フラグ。確定 predatory ではない (IEEE の一部も Ei 名乗り)。
PREDATORY_HINTS = (
    "ei compendex", "scopus", "ieee xplore", "indexed by",
)


def is_predatory(text: str) -> bool:
    t = text.lower()
    return any(h in t for h in PREDATORY_HINTS)


def norm_title(title: str) -> str:
    """年・記号を落とした正規化タイトル (重複グループ検出用)。"""
    t = title.lower()
    t = re.sub(r"'\d\d\b", "", t)      # '26 形式の短縮年
    t = re.sub(r"\b20\d\d\b", "", t)   # 2026 形式の年
    t = re.sub(r"[^a-z0-9]+", " ", t)
    return " ".join(t.split())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--candidates", default=str(ROOT / "data/discovered_candidates.yaml"))
    ap.add_argument("--limit", type=int, default=60)
    args = ap.parse_args()

    data = yaml.safe_load(open(args.candidates, encoding="utf-8"))
    cands = data.get("conferences", [])

    today = date.today()
    enriched = []
    for c in cands:
        ed = (c.get("editions") or [{}])[0]
        date_text = ed.get("date_text") or ""
        enriched.append({
            "c": c,
            "dl": _parse_deadline(date_text),
            "date_text": date_text,
            "pred": is_predatory((c.get("title") or "") + " " + (c.get("full_name") or "")),
        })

    future = sorted((e for e in enriched if e["dl"] and e["dl"] >= today), key=lambda x: x["dl"])
    past = [e for e in enriched if e["dl"] and e["dl"] < today]
    unknown = [e for e in enriched if not e["dl"]]

    print(f"=== レビュー推奨: 締切昇順 (未来 {len(future)} 件中 上位 {args.limit} 件) ===")
    for e in future[: args.limit]:
        flag = " [predatory疑い]" if e["pred"] else ""
        print(f"{e['dl']}  {e['c']['title'][:44]}{flag}")
        print(f"    {e['c'].get('link', '')}  tags={e['c'].get('tags')}")

    groups = defaultdict(list)
    for e in enriched:
        groups[norm_title(e["c"]["title"])].append(e)
    dups = {k: v for k, v in groups.items() if len(v) > 1}
    print(f"\n=== 重複グループ ({len(dups)} 組) ===")
    for k, v in sorted(dups.items(), key=lambda x: -len(x[1]))[:20]:
        srcs = [f"{e['c']['title']}@{(e['c'].get('tags') or ['?'])[-1]}" for e in v]
        print(f"- {k}: {srcs}")

    preds = [e for e in enriched if e["pred"]]
    print(f"\n=== predatory 疑い ({len(preds)} / {len(cands)} 件) ===")
    for e in preds[:20]:
        print(f"- {e['c']['title'][:50]}")

    print(f"\n=== 過去締切のみ ({len(past)} 件・レビュー不要/削除候補) ===")
    print(f"=== 締切不明 ({len(unknown)} 件・公式サイト確認が必要) ===")


if __name__ == "__main__":
    main()
