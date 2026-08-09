"""会議スコープのセマンティック埋め込みを生成する (public/embeddings.json)。

使い方:
    env -u PYTHONPATH .venv/bin/python -m scripts.embeddings public/data.json public/embeddings.json

各会議の title + full_name + categories + tags を all-MiniLM-L6-v2 で 384 次元に
埋め込み、{"<key>": [0.01, ...], ...} の形で保存する。ブラウザ側は
transformers.js で同じモデルを読み、ユーザー入力とのコサイン類似度を
レコメンドスコアに合成する（site/recommender.js の semanticScore）。

モデル未取得（オフライン）でも既存の embeddings.json があれば再生成しない。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path


def build_embeddings(data_path: Path, out_path: Path) -> dict:
    from fastembed import TextEmbedding

    data = json.loads(data_path.read_text(encoding="utf-8"))
    confs = data["conferences"]

    model = TextEmbedding("sentence-transformers/all-MiniLM-L6-v2")
    texts = []
    keys = []
    for c in confs:
        key = c["key"]
        parts = [
            c.get("title") or "",
            c.get("full_name") or "",
            " ".join(c.get("categories") or []),
            " ".join(c.get("tags") or []),
        ]
        text = " ".join(p for p in parts if p).strip()
        texts.append(text or key)
        keys.append(key)

    out = {}
    # fastembed は batch 対応。全件を一括で埋め込む
    vectors = list(model.embed(texts))
    for k, v in zip(keys, vectors):
        out[k] = [round(float(x), 6) for x in v]

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps({"model": "sentence-transformers/all-MiniLM-L6-v2", "dim": 384, "embeddings": out}),
        encoding="utf-8",
    )
    return out


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if len(argv) != 2:
        print("usage: python -m scripts.embeddings <data.json> <embeddings.json>", file=sys.stderr)
        return 2
    data_path = Path(argv[0])
    out_path = Path(argv[1])
    if not data_path.is_file():
        print(f"data not found: {data_path}", file=sys.stderr)
        return 1
    if out_path.is_file():
        print(f"embeddings already exist: {out_path} (skip)", file=sys.stderr)
        return 0
    out = build_embeddings(data_path, out_path)
    print(f"embeddings written: {len(out)} conferences -> {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
