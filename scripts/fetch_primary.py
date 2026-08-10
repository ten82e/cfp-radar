"""一次ソースから締切を一発どりする (data/primary.yaml → data/primary_overrides.yaml)。

data/primary.yaml に会議ごとの一次ソース URL を登録しておくと、このスクリプトが
ページを取得して締切を抽出し、data/primary_overrides.yaml を自動生成する。
build (scripts.cli) は overrides.yaml の後に primary_overrides.yaml を適用するので、
抽出された締切が上流データを自動訂正する。

安全ルール:
  - 「deadline」キーワード行の近傍 (前後 1 行) の日付だけを抽出する。裸の日付は抽出しない。
  - 抽出日付の年が edition 年の前年〜同年でないものは無視する (過去版の残骸防止)。
  - 取得失敗・抽出 0 件の会議は primary_overrides.yaml に書かない (前回値を維持)。

使い方:
  python -m scripts.fetch_primary            # 差分を表示 (dry-run)
  python -m scripts.fetch_primary --apply    # primary_overrides.yaml に書き込む
"""

from __future__ import annotations

import argparse
import html
import re
import ssl
import sys
import urllib.request
from datetime import date, datetime
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
REGISTRY = ROOT / "data" / "primary.yaml"
OUT = ROOT / "data" / "primary_overrides.yaml"

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"

# ブロック要素・セルは行境界にする。見出しや <li> も同様。
_BLOCK_RE = re.compile(
    r"<(?:br|/p|/div|/tr|/td|/th|/li|/h[1-6]|/section|/article|/table|/ul|/ol|/dl)[^>]*>",
    re.IGNORECASE,
)
_TAG_RE = re.compile(r"<[^>]+>")
_DATE_RE = re.compile(
    r"\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? "
    r"(\d{1,2})(?:st|nd|rd|th)?(?:,)? (\d{4})\b",
    re.IGNORECASE,
)
# 略号はよく使われるものだけ。オフセット形式 (UTC+9 等) は resolve_tz が受けるが
# 「行ウィンドウ」からの誤検知が多いので拾わない。
_TZ_RE = re.compile(
    r"\b(PDT|PST|EDT|EST|CDT|CST|MDT|MST|AKDT|AKST|HST|UTC|GMT|CET|CEST|JST|AoE|PT|ET|CT|MT)\b"
    r"|anywhere on (?:the )?(?:inhabited )?earth",
    re.IGNORECASE,
)
_ROUND_RE = re.compile(r"\bround\s*(\d+)\b", re.IGNORECASE)
_MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}
_LABELS = {
    "paper": "Paper submission",
    "abstract": "Abstract submission",
    "camera_ready": "Camera-ready submission",
    "notification": "Notification",
    "registration": "Registration",
}


def fetch(url: str, timeout: int = 30) -> str:
    """ページを取得する。証明書エラー (検証不能なサイトが多い) は検証を迂回する。"""
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
        if resp is None:
            raise RuntimeError("urlopen returned None")
        return resp.read().decode("utf-8", errors="replace")


def to_lines(html_text: str) -> list[str]:
    text = _BLOCK_RE.sub("\n", html_text)
    text = _TAG_RE.sub("", text)
    text = html.unescape(text)
    text = re.sub(r"[ \t\u00a0]+", " ", text)
    return [ln.strip() for ln in text.splitlines() if ln.strip()]


def _kind_of(window: str) -> str:
    low = window.lower()
    if "abstract" in low:
        return "abstract"
    if "camera" in low:
        return "camera_ready"
    if "notification" in low:
        return "notification"
    if "registration" in low:
        return "registration"
    return "paper"


def extract_deadline(window: str, year: int) -> dict | None:
    """キーワード行ウィンドウから締切 1 件を抽出する。根拠が無ければ None。

    window は「deadline を含む行 + 前後 1 行」を連結したテキスト。
    保守的に: deadline キーワードが無い window は None。
    """
    low = window.lower()
    if "deadline" not in low and "due date" not in low:
        return None
    m = _DATE_RE.search(window)
    if not m:
        return None
    month = _MONTHS[m.group(1).lower()[:3]]
    day = int(m.group(2))
    extracted_year = int(m.group(3))
    if extracted_year not in (year - 1, year):  # 過去版の残骸を拾わない
        return None
    try:
        dt = datetime(extracted_year, month, day)
    except ValueError:
        return None
    kind = _kind_of(window)
    round_m = _ROUND_RE.search(window)
    round_no = int(round_m.group(1)) if round_m else 1
    label = _LABELS[kind]
    if round_no > 1:
        label = f"Round {round_no} {label}"
    tz = None
    tz_m = _TZ_RE.search(window)
    if tz_m:
        tz_raw = tz_m.group(0)
        if "anywhere" in tz_raw.lower():
            tz = "AoE"
        elif tz_raw.upper() == "AOE":
            tz = "AoE"
        else:
            tz = tz_raw.upper()
    return {
        "kind": kind,
        "label": label,
        "date": dt.date().isoformat(),
        "tz": tz,
        "round": round_no,
    }


def page_year(html_text: str, default: int) -> int:
    """ページ <title> から edition 年を確定する。無ければ default。

    サイトに前年版の締切が残っていても、title の年で edition を特定できれば
    残骸を拾わない。default から ±1 年以内の年だけ採用する (未来版の誤検出防止)。
    """
    m = re.search(r"<title[^>]*>(.*?)</title>", html_text, re.IGNORECASE | re.DOTALL)
    if not m:
        return default
    title = html.unescape(m.group(1))
    years = [int(x) for x in re.findall(r"\b(20\d{2})\b", title)]
    # title の年は default を裏付ける時のみ採用する。別の年 (古い版・未来版) は
    # ページが別版の可能性があるため信頼せず、レジストリの default を維持する。
    for y in years:
        if y == default:
            return y
    return default


def extract_deadlines(lines: list[str], year: int) -> list[dict]:
    """ページ全体から締切リストを抽出する。"""
    out: list[dict] = []
    for i, ln in enumerate(lines):
        low = ln.lower()
        if "deadline" not in low and "due date" not in low:
            continue
        lo = max(0, i - 1)
        hi = min(len(lines), i + 2)
        window = " ".join(lines[lo:hi])
        entry = extract_deadline(window, year)
        if entry and entry not in out:
            out.append(entry)
    return out


def _load(path: Path) -> dict:
    if not path.is_file():
        return {}
    return yaml.safe_load(path.read_text(encoding="utf-8")) or {}


def _write(path: Path, payload: dict) -> None:
    path.write_text(yaml.dump(payload, allow_unicode=True, sort_keys=False), encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--apply", action="store_true", help="primary_overrides.yaml に書き込む")
    args = parser.parse_args(argv)

    registry = _load(REGISTRY).get("conferences") or {}
    previous = _load(OUT).get("conferences") or {}
    if not registry:
        print(f"error: {REGISTRY} に conferences が無い", file=sys.stderr)
        return 2

    today = date.today()
    generated: dict[str, dict] = {}
    for key, conf in sorted(registry.items()):
        url = conf.get("url")
        year = conf.get("year")
        if not url or not year:
            print(f"warning: {key} に url/year が無いのでスキップ", file=sys.stderr)
            continue
        try:
            page = fetch(url)
            page_yr = page_year(page, int(year))
            if page_yr != int(year):
                print(f"warning: {key}: title の年が {page_yr} (registry: {year}) — "
                      f"registry の year 更新を検討", file=sys.stderr)
            lines = to_lines(page)
            deadlines = extract_deadlines(lines, page_yr)
            # 出力は最小限に: tz 不明・round 1 のキーは落とす (既定値は merge 側が補う)
            for d in deadlines:
                if d["tz"] is None:
                    del d["tz"]
                if d["round"] == 1:
                    del d["round"]
        except Exception as exc:
            print(f"warning: {key}: {url} の取得に失敗 ({exc}) — 前回値を維持", file=sys.stderr)
            if key in previous:
                generated[key] = previous[key]
            continue
        if not deadlines:
            print(f"warning: {key}: {url} から締切を抽出できなかった — 前回値を維持", file=sys.stderr)
            if key in previous:
                generated[key] = previous[key]
            continue

        edition: dict = {"deadlines": deadlines}
        for field in ("link", "place", "date_text"):
            if conf.get(field):
                edition[field] = conf[field]
        comment = f"一次ソース ({url}) から自動抽出 ({today.isoformat()})"
        entry = {"editions": {int(year): edition}}
        # 手書きのメタ (link/place/date_text) は「レジストリ由来」、締切は「抽出」。
        entry["_comment"] = comment
        generated[key] = entry

    if not generated:
        print("抽出できた会議が無い。primary_overrides.yaml は変更しない。")
        return 1

    payload = {
        "#": "自動生成。scripts/fetch_primary.py が data/primary.yaml の一次ソースから"
        "抽出した。手で編集しない。抽出失敗した会議は前回値が維持される。",
        "conferences": generated,
    }
    if args.apply:
        _write(OUT, payload)
        print(f"wrote {OUT} ({len(generated)} conferences)")
    else:
        print(f"--- dry-run: {OUT} ({len(generated)} conferences) ---")
        print(yaml.dump(payload, allow_unicode=True, sort_keys=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
