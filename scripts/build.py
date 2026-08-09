"""Output generation: ICS / JSON / CSV / Markdown / llms.txt / HTML.

Everything under public/ is produced here.  Rendering is a pure function of
(conferences, config, now) so that two runs with the same input are byte
identical.
"""

from __future__ import annotations

import csv
import io
import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from .model import AOE, Conference

ROOT = Path(__file__).resolve().parent.parent

# --- constants ---------------------------------------------------------------

KIND_LABEL_JA = {
    "abstract": "概要締切",
    "paper": "論文締切",
    "supplementary": "補足資料締切",
    "notification": "採否通知",
    "camera_ready": "カメラレディ締切",
    "rebuttal_start": "反論期間開始",
    "rebuttal_end": "反論期間終了",
    "review_release": "査読結果公開",
    "registration": "登録締切",
    "other": "締切",
}

DEFAULT_CATEGORIES = {
    "hpc": "High Performance Computing",
    "networking": "Networking",
    "systems": "Systems",
    "ai": "Artificial Intelligence / Machine Learning",
    "security": "Security",
}

DEFAULT_SOURCES = [
    {"name": "ccfddl", "repo": "ccfddl/ccf-deadlines", "license": "MIT"},
    {"name": "aideadlines", "repo": "huggingface/ai-deadlines", "license": "MIT"},
    {"name": "local", "repo": "data/extra.yaml", "license": "MIT"},
]

ALARM_TRIGGERS = ("-P7D", "-P1D", "-PT3H")

CSV_COLUMNS = [
    "key", "title", "full_name", "categories", "rank_ccf", "rank_core",
    "year", "edition_id", "kind", "label", "round",
    "deadline_utc", "deadline_aoe", "tz_raw",
    "event_start", "event_end", "place", "date_text",
    "estimated", "sources", "link",
]

TEMPLATE_MARKER = "/*__DATA__*/null"

# SPEC.md 4.1: the UID right-hand side is frozen.  Changing it (repository
# rename, custom domain) would re-register every event in every subscriber's
# calendar, so it is deliberately not derived from config.
UID_DOMAIN = "conf-deadlines.github.io"


# --- ICS primitives ----------------------------------------------------------


def escape_text(value: str) -> str:
    """RFC 5545 TEXT escaping.  ':' is deliberately NOT escaped (breaks URLs)."""
    out = value.replace("\\", "\\\\")
    out = out.replace(";", "\\;").replace(",", "\\,")
    out = out.replace("\r\n", "\n").replace("\r", "\n").replace("\n", "\\n")
    return out


def _uri_value(value: str) -> str:
    """A URI property value: strip control characters, escape nothing else."""
    return "".join(ch for ch in str(value) if ch >= " " and ch != "\x7f")


def fold_line(line: str) -> str:
    """Fold a content line at 75 octets, never splitting a UTF-8 sequence."""
    raw = line.encode("utf-8")
    if len(raw) <= 75:
        return line
    pieces: list[bytes] = []
    start = 0
    limit = 75  # first line: 75 octets; continuations carry a leading space
    while start < len(raw):
        end = min(start + limit, len(raw))
        if end < len(raw):
            # back off to a UTF-8 character boundary
            while end > start and (raw[end] & 0xC0) == 0x80:
                end -= 1
        pieces.append(raw[start:end])
        start = end
        limit = 74
    return "\r\n ".join(p.decode("utf-8") for p in pieces)


def _fmt_utc(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _fmt_date(d: date) -> str:
    return d.strftime("%Y%m%d")


def render_ics(entries: list[dict], *, calname: str, caldesc: str) -> str:
    """Render calendar entries as an RFC 5545 stream (CRLF terminated).

    No ``METHOD`` is emitted (SPEC.md 4.1): with METHOD the stream becomes an
    iTIP object, RFC 5546 2.1.5 makes DTSTAMP the freshness signal and
    3.2 requires an ORGANIZER.  This feed fixes DTSTAMP and has no organizer,
    so METHOD is left out and DTSTAMP keeps its RFC 5545 3.8.7.2 meaning.
    """
    lines: list[str] = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//conf-deadlines//conf-deadlines//EN",
        "CALSCALE:GREGORIAN",
        f"X-WR-CALNAME:{escape_text(calname)}",
        f"X-WR-CALDESC:{escape_text(caldesc)}",
        "X-WR-TIMEZONE:UTC",
        "REFRESH-INTERVAL;VALUE=DURATION:PT12H",
        "X-PUBLISHED-TTL:PT12H",
    ]
    for entry in entries:
        lines.append("BEGIN:VEVENT")
        lines.append(f"UID:{escape_text(entry['uid'])}")
        lines.append(f"DTSTAMP:{_fmt_utc(entry['dtstamp'])}")
        if entry.get("all_day"):
            lines.append(f"DTSTART;VALUE=DATE:{_fmt_date(entry['start'])}")
            # RFC 5545: DTEND is exclusive for DATE values
            lines.append(
                f"DTEND;VALUE=DATE:{_fmt_date(entry['end'] + timedelta(days=1))}"
            )
        else:
            lines.append(f"DTSTART:{_fmt_utc(entry['start'])}")
            lines.append(f"DTEND:{_fmt_utc(entry['end'])}")
        lines.append(f"SUMMARY:{escape_text(entry['summary'])}")
        if entry.get("description"):
            lines.append(f"DESCRIPTION:{escape_text(entry['description'])}")
        if entry.get("url"):
            # URL is a URI value (RFC 5545 3.8.4.6), not TEXT: no escaping.
            lines.append(f"URL:{_uri_value(entry['url'])}")
        if entry.get("categories"):
            lines.append(
                "CATEGORIES:" + ",".join(escape_text(c) for c in entry["categories"])
            )
        for trigger in entry.get("alarms", ()):
            lines.append("BEGIN:VALARM")
            lines.append("ACTION:DISPLAY")
            lines.append(f"DESCRIPTION:{escape_text(entry['summary'])}")
            lines.append(f"TRIGGER:{trigger}")
            lines.append("END:VALARM")
        lines.append("END:VEVENT")
    lines.append("END:VCALENDAR")
    return "".join(fold_line(line) + "\r\n" for line in lines)


# --- record extraction -------------------------------------------------------


def _aoe_text(at_utc: datetime) -> str:
    return at_utc.astimezone(AOE).strftime("%Y-%m-%d %H:%M:%S") + " AoE"


def _rank_text(rank: dict) -> str:
    return ", ".join(f"{k.upper()} {v}" for k, v in sorted(rank.items()) if v)


def _deadline_ordinals(editions: list) -> dict[tuple[int, int], int]:
    """Number deadlines 1.. within each (year, kind), ordered by ``at_utc``.

    SPEC.md 4.1: the UID ordinal must not be the timeline array index
    (``round``), because upstream reorders that array and the UID would then
    point at a different deadline.  The key is ``(edition index, deadline
    index)`` into the *sorted* lists used below.
    """
    groups: dict[tuple[int, str], list[tuple]] = {}
    for i, ed in enumerate(editions):
        for j, dl in enumerate(_sorted_deadlines(ed)):
            groups.setdefault((ed.year, dl.kind), []).append(
                (dl.at_utc, ed.edition_id, dl.round, dl.label or "", i, j)
            )
    out: dict[tuple[int, int], int] = {}
    for items in groups.values():
        for n, item in enumerate(sorted(items), start=1):
            out[(item[4], item[5])] = n
    return out


def _event_ordinals(editions: list) -> dict[int, int]:
    """Number the meetings of one ``(key, year)`` by ``event_start`` (SPEC.md 4.1).

    A conference can meet twice in one year (the domestic SIG workshops in
    ``data/extra.yaml``), so the event UID needs an ordinal too.  Ordinal 1
    carries no suffix, which keeps the UID of every once-a-year conference the
    same as before this rule existed.
    """
    groups: dict[int, list[tuple]] = {}
    for i, ed in enumerate(editions):
        if ed.event_start:
            groups.setdefault(ed.year, []).append((ed.event_start, ed.edition_id, i))
    out: dict[int, int] = {}
    for items in groups.values():
        for n, item in enumerate(sorted(items), start=1):
            out[item[2]] = n
    return out


def _sorted_deadlines(edition) -> list:
    return sorted(
        edition.deadlines, key=lambda d: (d.round, d.at_utc, d.kind, d.label or "")
    )


def _collisions(editions: list) -> set[tuple[int, str, datetime]]:
    """``(year, kind, at_utc)`` groups holding more than one deadline.

    SPEC.md 3.6 keeps the separate tracks a single source files under one
    instant (SIGGRAPH 2026 has three at 2026-04-21T22:00:00Z).  They would
    otherwise render as identical rows and identical calendar entries, so the
    upstream label is appended to the title of exactly these.
    """
    seen: dict[tuple[int, str, datetime], int] = {}
    for ed in editions:
        for dl in ed.deadlines:
            key = (ed.year, dl.kind, dl.at_utc)
            seen[key] = seen.get(key, 0) + 1
    return {key for key, count in seen.items() if count > 1}


def _event_suffix(ordinal: int) -> str:
    return "" if ordinal == 1 else f"-{ordinal}"


def _records(confs: list[Conference]) -> list[dict]:
    """Flatten conferences into calendar records (entry + routing metadata)."""
    records: list[dict] = []
    used_uids: dict[str, int] = {}

    def uid(base: str) -> str:
        """Return ``base``; a repeat gets a ``-N`` suffix so UIDs stay unique.

        Deadline and event UIDs already carry an ordinal that is unique inside
        their group (SPEC.md 4.1), so this is only a last-resort guard.
        """
        n = used_uids.get(base, 0) + 1
        used_uids[base] = n
        if n == 1:
            return base
        local, _, dom = base.partition("@")
        return f"{local}-{n}@{dom}"

    for conf in sorted(confs, key=lambda c: c.key):
        cats = list(conf.categories)
        rank = _rank_text(conf.rank)
        editions = sorted(conf.editions, key=lambda e: (e.year, e.edition_id))
        ordinals = _deadline_ordinals(editions)
        event_ordinals = _event_ordinals(editions)
        collisions = _collisions(editions)
        for ed_index, ed in enumerate(editions):
            link = ed.link or conf.link
            for dl_index, dl in enumerate(_sorted_deadlines(ed)):
                label_ja = KIND_LABEL_JA.get(dl.kind, KIND_LABEL_JA["other"])
                if (ed.year, dl.kind, dl.at_utc) in collisions and dl.label:
                    label_ja = f"{label_ja}: {dl.label}"
                desc = [
                    f"{conf.full_name or conf.title}",
                    f"{dl.label or label_ja}: {_aoe_text(dl.at_utc)}"
                    f" / {dl.at_utc.astimezone(timezone.utc):%Y-%m-%d %H:%M:%S} UTC"
                    f" (元表記 {dl.tz_raw or 'UTC'})",
                    f"ラウンド: {dl.round}",
                ]
                if rank:
                    desc.append(f"ランク: {rank}")
                if ed.place:
                    desc.append(f"開催地: {ed.place}")
                if ed.date_text:
                    desc.append(f"会期: {ed.date_text}")
                if link:
                    desc.append(f"リンク: {link}")
                if dl.comment:
                    desc.append(f"備考: {dl.comment}")
                if ed.estimated:
                    desc.append("※ 推定日程（上流に未掲載のため過去実績から算出）")
                desc.append(f"出典: {ed.source or ','.join(conf.sources)}")
                records.append(
                    {
                        "type": "deadline",
                        "categories": cats,
                        "kind_label": label_ja,
                        "estimated": ed.estimated,
                        "conf": conf,
                        "edition": ed,
                        "deadline": dl,
                        "entry": {
                            "uid": uid(
                                f"{conf.key}-{ed.year}-{dl.kind}"
                                f"-{ordinals[(ed_index, dl_index)]}@{UID_DOMAIN}"
                            ),
                            "summary": f"{conf.title} {ed.year} {label_ja}"
                            + ("（推定）" if ed.estimated else ""),
                            "description": "\n".join(desc),
                            "url": link,
                            "categories": cats + [dl.kind],
                            "all_day": False,
                            "start": dl.at_utc - timedelta(minutes=30),
                            "end": dl.at_utc,
                            "alarms": list(ALARM_TRIGGERS),
                        },
                    }
                )
            if ed.event_start and not ed.estimated:
                desc = [conf.full_name or conf.title]
                if ed.date_text:
                    desc.append(f"会期: {ed.date_text}")
                if ed.place:
                    desc.append(f"開催地: {ed.place}")
                if rank:
                    desc.append(f"ランク: {rank}")
                if link:
                    desc.append(f"リンク: {link}")
                desc.append(f"出典: {ed.source or ','.join(conf.sources)}")
                records.append(
                    {
                        "type": "event",
                        "categories": cats,
                        "estimated": False,
                        "conf": conf,
                        "edition": ed,
                        "deadline": None,
                        "entry": {
                            "uid": uid(
                                f"{conf.key}-{ed.year}-event"
                                + _event_suffix(event_ordinals.get(ed_index, 1))
                                + f"@{UID_DOMAIN}"
                            ),
                            "summary": f"{conf.title} {ed.year}",
                            "description": "\n".join(desc),
                            "url": link,
                            "categories": cats + ["event"],
                            "all_day": True,
                            "start": ed.event_start,
                            "end": ed.event_end or ed.event_start,
                            "alarms": [],
                        },
                    }
                )
    return records


def _sort_key(rec: dict):
    entry = rec["entry"]
    start = entry["start"]
    if isinstance(start, datetime):
        stamp = start.astimezone(timezone.utc).timestamp()
    else:
        stamp = datetime(
            start.year, start.month, start.day, tzinfo=timezone.utc
        ).timestamp()
    return (stamp, entry["uid"])


# --- serialisation -----------------------------------------------------------


def _to_json(confs: list[Conference], config: dict, now: datetime) -> dict:
    categories = config.get("categories") or DEFAULT_CATEGORIES
    sources = config.get("sources") or DEFAULT_SOURCES
    out_confs = []
    for conf in sorted(confs, key=lambda c: c.key):
        editions = []
        for ed in sorted(conf.editions, key=lambda e: (e.year, e.edition_id)):
            editions.append(
                {
                    "year": ed.year,
                    "id": ed.edition_id,
                    "link": ed.link or conf.link,
                    "place": ed.place,
                    "date_text": ed.date_text,
                    "event_start": ed.event_start.isoformat() if ed.event_start else None,
                    "event_end": ed.event_end.isoformat() if ed.event_end else None,
                    "estimated": ed.estimated,
                    "source": ed.source,
                    "deadlines": [
                        {
                            "kind": dl.kind,
                            "label": dl.label,
                            "utc": dl.at_utc.astimezone(timezone.utc).strftime(
                                "%Y-%m-%dT%H:%M:%SZ"
                            ),
                            "aoe": _aoe_text(dl.at_utc),
                            "tz_raw": dl.tz_raw,
                            "round": dl.round,
                            "comment": dl.comment,
                        }
                        for dl in sorted(
                            ed.deadlines,
                            key=lambda d: (d.round, d.at_utc, d.kind, d.label or ""),
                        )
                    ],
                }
            )
        out_confs.append(
            {
                "key": conf.key,
                "title": conf.title,
                "full_name": conf.full_name,
                "categories": list(conf.categories),
                "rank": dict(conf.rank),
                "link": conf.link,
                "tags": list(conf.tags),
                "sources": list(conf.sources),
                "editions": editions,
            }
        )
    return {
        "generated_at": now.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "sources": sources,
        "categories": dict(categories),
        "conferences": out_confs,
    }


def _to_csv(records: list[dict]) -> str:
    buf = io.StringIO(newline="")
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow(CSV_COLUMNS)
    for rec in records:
        if rec["type"] != "deadline":
            continue
        conf, ed, dl = rec["conf"], rec["edition"], rec["deadline"]
        writer.writerow(
            [
                conf.key,
                conf.title,
                conf.full_name,
                ";".join(conf.categories),
                conf.rank.get("ccf", ""),
                conf.rank.get("core", ""),
                ed.year,
                ed.edition_id,
                dl.kind,
                dl.label,
                dl.round,
                dl.at_utc.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                _aoe_text(dl.at_utc),
                dl.tz_raw,
                ed.event_start.isoformat() if ed.event_start else "",
                ed.event_end.isoformat() if ed.event_end else "",
                ed.place,
                ed.date_text,
                "true" if ed.estimated else "false",
                ";".join(conf.sources),
                ed.link or conf.link,
            ]
        )
    return buf.getvalue()


def _to_upcoming_md(records: list[dict], now: datetime, days: int = 180) -> str:
    """The table README points at: deadlines *and* meetings of the next ``days``.

    The two row types use the selection rule the site uses by default
    (SPEC.md 7): a deadline is over the instant it passes, a meeting only once
    its last day is over, so a conference stays listed while it is running.
    """
    horizon = now + timedelta(days=days)
    today = now.date()
    rows = []
    for rec in records:
        conf, ed = rec["conf"], rec["edition"]
        link = ed.link or conf.link
        name = f"[{conf.title} {ed.year}]({link})" if link else f"{conf.title} {ed.year}"
        if rec["type"] == "deadline":
            dl = rec["deadline"]
            if not (now <= dl.at_utc <= horizon):
                continue
            remain = dl.at_utc - now
            left = f"{remain.days}日" if remain.days >= 1 else f"{remain.seconds // 3600}時間"
            when, kind_text, round_text = _aoe_text(dl.at_utc), rec["kind_label"], f"R{dl.round}"
        else:
            start = ed.event_start
            end = ed.event_end or start
            if start > horizon.date() or today > end:
                continue
            if today < start:
                left = f"{(start - today).days}日"
            elif today == start:
                left = "本日開催"
            else:
                left = f"開催中(残り{(end - today).days + 1}日)"
            when = f"{start} 〜 {end}" if end != start else f"{start}"
            kind_text, round_text = "開催", "-"
        rows.append(
            "| {} | {} | {} | {} | {} | {} | {} |".format(
                when, left, name, kind_text, round_text,
                "推定" if ed.estimated else "", ed.place or "",
            )
        )
    head = [
        f"# 直近 {days} 日の締切と開催",
        "",
        f"生成時刻: {now.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}",
        "",
        "| 日付 | 残り | 会議 | 種別 | R | 推定 | 開催地 |",
        "|---|---|---|---|---|---|---|",
    ]
    if not rows:
        rows = ["| - | - | 該当なし | - | - | - | - |"]
    return "\n".join(head + rows) + "\n"


def _to_llms_txt(base_url: str, feeds: list[tuple[str, str]], config: dict) -> str:
    categories = config.get("categories") or DEFAULT_CATEGORIES
    sources = config.get("sources") or DEFAULT_SOURCES
    lines = [
        "# conf-deadlines",
        "",
        "HPC・ネットワーク・システム・AI 系の国際会議の投稿締切と開催日を、",
        "上流の公開データから日次で正規化して配信する静的フィード集である。",
        "サーバは無く、GitHub Pages 上の静的ファイルだけで構成される。",
        "",
        "## 更新頻度",
        "",
        "毎日 20:17 UTC（05:17 JST）に GitHub Actions が上流を取得して再生成する。",
        "各 ICS は REFRESH-INTERVAL / X-PUBLISHED-TTL に PT12H を宣言している。",
        "",
        "## フィード一覧（絶対 URL）",
        "",
    ]
    for name, meaning in feeds:
        lines.append(f"- {base_url}/{name} — {meaning}")
    lines += [
        "",
        "## data.json のスキーマ要約",
        "",
        "トップレベルは以下のキーを持つオブジェクトである。",
        "",
        "- generated_at: string — 生成時刻。'YYYY-MM-DDTHH:MM:SSZ'（UTC）。",
        "- sources: array of {name, repo, license} — 出典と授権。",
        "- categories: object — カテゴリ ID から英語名への写像。",
        "  実在値: " + ", ".join(sorted(categories)) + "。",
        "- conferences: array — 会議の配列。各要素は次の形である。",
        "  - key: string — 正規化キー（slug）。例 'sigcomm'。",
        "  - title: string — 略称。例 'SIGCOMM'。",
        "  - full_name: string — 正式名称。",
        "  - categories: array of string — 上記 categories のキー。",
        "  - rank: object — {'ccf': 'A', 'core': 'A*'} 等。欠けうる。",
        "    値 'N' は上流でランクが付いていないことを表す番兵であり、等級ではない。",
        "  - link: string — 会議の公式サイト。",
        "  - tags: array of string — 補助タグ。カテゴリではない。",
        "  - sources: array of string — この会議の出典名。",
        "  - editions: array — 開催回。各要素は次の形である。",
        "    - year: integer, id: string（例 'sigcomm26'）, link: string, place: string",
        "    - date_text: string — 上流の自由文の会期表記。構造化されていないことがある。",
        "    - event_start / event_end: string|null — 'YYYY-MM-DD'。パース不能なら null。",
        "    - estimated: boolean — true は過去実績からの推定。実データではない。",
        "    - source: string — この開催回を提供した出典名。",
        "    - deadlines: array — 各要素は次の形である。",
        "      - kind: string — 'abstract'|'paper'|'supplementary'|'notification'"
        "|'camera_ready'|'rebuttal_start'|'rebuttal_end'|'review_release'"
        "|'registration'|'other' の 10 種のみ。",
        "      - label: string — 上流の表示用ラベル。",
        "      - utc: string — 'YYYY-MM-DDTHH:MM:SSZ'。比較・整列にはこれを使う。",
        "      - aoe: string — 'YYYY-MM-DD HH:MM:SS AoE'（UTC-12 での表記）。",
        "      - tz_raw: string — 上流の元タイムゾーン表記。",
        "      - round: integer — 1 起点。複数投稿ラウンドを持つ会議がある。",
        "      - comment: string|null — 上流の注記。",
        "",
        "## 利用上の注意",
        "",
        "- 締切の比較は必ず deadlines[].utc で行う。aoe は表示用である。",
        "- estimated=true の版は推定であり、all.ics と分野別 ICS には含まれない。"
        "推定は all-estimated.ics と <カテゴリ>-estimated.ics にのみ出る。",
        "- data.csv は 1 行 1 締切のフラット表で、data.json の部分集合である。",
        "  comment・tags・thcpl ランクは列に無い。全情報が要るときは data.json を使う。",
        "- 権威は上流と各会議の公式サイトである。重要な判断の前に link 先を確認すること。",
        "",
        "## 出典とライセンス",
        "",
    ]
    for src in sources:
        lines.append(
            f"- {src.get('name')}: {src.get('repo')} （{src.get('license')}）"
        )
    lines += [
        "",
        "本リポジトリの生成物は MIT ライセンスで配布する。",
        "上流データの権利は各上流リポジトリに帰属し、NOTICE.md に帰属表示がある。",
        "",
    ]
    return "\n".join(lines)


def _embed_json(js_json: str) -> str:
    """Make a JSON literal safe to paste into a <script> body."""
    return (
        js_json.replace("</", "<\\/")
        .replace("<!--", "\\u003c!--")
        .replace("\u2028", "\\u2028")
        .replace("\u2029", "\\u2029")
    )


# --- entry point -------------------------------------------------------------


def build_all(
    confs: list[Conference], config: dict, outdir: Path, now: datetime
) -> dict:
    """Generate everything under ``outdir`` and return a stats dict."""
    outdir = Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    now = now.astimezone(timezone.utc)
    # DTSTAMP is derived from --now (floored to the day) so that repeated runs
    # over unchanged data produce byte identical calendars.
    dtstamp = now.replace(hour=0, minute=0, second=0, microsecond=0)

    site = config.get("site") or {}
    domain = site.get("domain") or "conf-deadlines"
    base_url = (site.get("base_url") or f"https://{domain}").rstrip("/")
    categories = config.get("categories") or DEFAULT_CATEGORIES

    records = _records(confs)
    records.sort(key=_sort_key)
    for rec in records:
        rec["entry"]["dtstamp"] = dtstamp

    def entries(pred) -> list[dict]:
        return [r["entry"] for r in records if pred(r)]

    live = lambda r: not r["estimated"]  # noqa: E731
    feeds: list[tuple[str, str, str, list[dict]]] = [
        (
            "all.ics",
            "会議締切・開催日（全カテゴリ）",
            "全カテゴリ・全種別の締切と開催日。推定は含まない。",
            entries(live),
        ),
    ]
    for cat in sorted(categories):
        feeds.append(
            (
                f"{cat}.ics",
                f"会議締切・開催日（{categories.get(cat, cat)}）",
                f"カテゴリ {cat} の締切と開催日。推定は含まない。",
                entries(lambda r, c=cat: live(r) and c in r["categories"]),
            )
        )
    feeds += [
        (
            "deadlines.ics",
            "会議締切のみ",
            "投稿・通知などの締切のみ。開催日は含まない。",
            entries(lambda r: live(r) and r["type"] == "deadline"),
        ),
        (
            "events.ics",
            "会議開催日のみ",
            "開催期間の終日イベントのみ。締切は含まない。",
            entries(lambda r: live(r) and r["type"] == "event"),
        ),
    ]
    # SPEC.md 4: the estimated deadlines are split by category as well.  A single
    # estimated.ics forces an HPC reader to take the AI estimates too, and the
    # confirmed HPC feed is thin enough that the estimates are not optional.
    est = lambda r: r["estimated"] and r["type"] == "deadline"  # noqa: E731
    feeds.append(
        (
            "all-estimated.ics",
            "推定締切（全カテゴリ・未確定）",
            "上流に未掲載のため過去実績から推定した締切。確定情報ではない。",
            entries(est),
        )
    )
    for cat in sorted(categories):
        feeds.append(
            (
                f"{cat}-estimated.ics",
                f"推定締切（{categories.get(cat, cat)}・未確定）",
                f"カテゴリ {cat} の推定締切のみ。確定情報ではない。",
                entries(lambda r, c=cat: est(r) and c in r["categories"]),
            )
        )

    written: list[str] = []

    def write(name: str, text: str) -> None:
        (outdir / name).write_text(text, encoding="utf-8", newline="")
        written.append(name)

    for name, calname, caldesc, ents in feeds:
        write(
            name,
            render_ics(ents, calname=calname, caldesc=caldesc),
        )

    data = _to_json(confs, config, now)
    json_text = json.dumps(data, ensure_ascii=False, indent=2, sort_keys=False)
    write("data.json", json_text + "\n")
    write("data.csv", _to_csv(records))
    write("upcoming.md", _to_upcoming_md(records, now))
    write(
        "llms.txt",
        _to_llms_txt(base_url, [(f[0], f[2]) for f in feeds] + [
            ("data.json", "正規化データ全体（機械可読の正）"),
            ("data.csv", "1 行 1 締切のフラット表"),
            ("upcoming.md", "直近 180 日の締切と開催の表"),
        ], config),
    )
    write(".nojekyll", "")

    template = Path(config.get("template") or "site/template.html")
    if not template.is_absolute() and not template.is_file():
        template = ROOT / template
    if template.is_file():
        html = template.read_text(encoding="utf-8")
        if TEMPLATE_MARKER not in html:
            print(
                f"warning: {template} に {TEMPLATE_MARKER} が見つからない。index.html を素通しする"
            )
        else:
            html = html.replace(
                TEMPLATE_MARKER, _embed_json(json.dumps(data, ensure_ascii=False))
            )
        write("index.html", html)
        # recommender.js をテンプレートと同じ場所から同梱（ブラウザから src 参照）
        rec = template.parent / "recommender.js"
        if rec.is_file():
            write("recommender.js", rec.read_text(encoding="utf-8"))
        else:
            print(f"warning: {rec} が無い。index.html の src 参照が 404 になる")
    else:
        print(f"warning: {template} が無いので index.html を生成しない")

    n_deadlines = sum(1 for r in records if r["type"] == "deadline")
    return {
        "generated_at": data["generated_at"],
        "conferences": len(confs),
        "editions": sum(len(c.editions) for c in confs),
        "deadlines": n_deadlines,
        "events": len(records) - n_deadlines,
        "estimated": sum(1 for r in records if r["estimated"]),
        "files": written,
    }
