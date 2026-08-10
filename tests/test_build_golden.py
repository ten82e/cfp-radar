"""End-to-end build from tests/fixtures/ only: SPEC.md sections 4 and 8."""

from __future__ import annotations

import csv
import io
import json
import re
from datetime import date, datetime, timezone

import pytest

from .conftest import NOW, NOW_ARG, PUBLIC_FILES

UTC = timezone.utc
ICS_FEEDS = [f for f in PUBLIC_FILES if f.endswith(".ics")]


@pytest.fixture(scope="module")
def site(tmp_path_factory, request):
    """Run the CLI offline against the fixture cache once for the whole module."""
    run = request.getfixturevalue("run_cli")
    outdir = tmp_path_factory.mktemp("site") / "public"
    proc = run(outdir)
    assert proc.returncode == 0, (
        f"cli build failed (rc={proc.returncode})\n"
        f"--- stdout ---\n{proc.stdout}\n--- stderr ---\n{proc.stderr}"
    )
    return outdir


@pytest.fixture(scope="module")
def data(site):
    return json.loads((site / "data.json").read_text(encoding="utf-8"))


# --- generated file set ----------------------------------------------------


@pytest.mark.parametrize("name", PUBLIC_FILES)
def test_public_file_is_generated(site, name):
    path = site / name
    assert path.exists(), f"{name} missing from public/"
    if name != ".nojekyll":
        assert path.stat().st_size > 0, f"{name} is empty"


def test_build_is_deterministic(tmp_path, run_cli, site):
    second = tmp_path / "public2"
    proc = run_cli(second)
    assert proc.returncode == 0, proc.stderr
    for name in PUBLIC_FILES:
        assert (site / name).read_bytes() == (second / name).read_bytes(), name


# --- data.json -------------------------------------------------------------


def test_data_json_top_level_shape(data):
    assert set(data) >= {"generated_at", "sources", "categories", "conferences"}
    assert data["generated_at"] == "2026-08-09T00:00:00Z"
    assert isinstance(data["categories"], dict)
    assert set(data["categories"]) >= {
        "hpc",
        "networking",
        "systems",
        "ai",
        "security",
    }
    assert isinstance(data["sources"], list) and data["sources"]
    for src in data["sources"]:
        assert set(src) >= {"name", "repo", "license"}


def test_conference_records_match_the_spec(data):
    assert data["conferences"], "no conferences survived the build"
    for conf in data["conferences"]:
        assert set(conf) >= {
            "key",
            "title",
            "full_name",
            "categories",
            "rank",
            "link",
            "sources",
            "editions",
        }
        assert isinstance(conf["categories"], list)
        assert isinstance(conf["rank"], dict)
        assert isinstance(conf["sources"], list) and conf["sources"]
        assert set(conf["sources"]) <= {"ccfddl", "aideadlines", "local"}


def test_edition_and_deadline_records_match_the_spec(data):
    seen_deadline = False
    for conf in data["conferences"]:
        for ed in conf["editions"]:
            assert set(ed) >= {
                "year",
                "id",
                "place",
                "link",
                "event_start",
                "event_end",
                "estimated",
                "deadlines",
            }
            assert isinstance(ed["year"], int)
            assert isinstance(ed["estimated"], bool)
            for key in ("event_start", "event_end"):
                if ed[key] is not None:
                    date.fromisoformat(ed[key])
            for dl in ed["deadlines"]:
                seen_deadline = True
                assert set(dl) >= {"kind", "label", "utc", "aoe", "tz_raw", "round"}
                assert dl["kind"] in {
                    "abstract",
                    "paper",
                    "supplementary",
                    "notification",
                    "camera_ready",
                    "rebuttal_start",
                    "rebuttal_end",
                    "review_release",
                    "registration",
                    "other",
                }
                assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", dl["utc"])
                assert dl["aoe"].endswith("AoE")
                assert isinstance(dl["round"], int) and dl["round"] >= 1
    assert seen_deadline, "no deadlines in the generated data"


def _conf(data, key):
    matches = [c for c in data["conferences"] if c["key"] == key]
    assert matches, f"{key} missing; got {sorted(c['key'] for c in data['conferences'])}"
    return matches[0]


def test_expected_fixture_conferences_are_present(data):
    keys = {c["key"] for c in data["conferences"]}
    assert {"sigcomm", "nsdi", "sc"} <= keys


def test_out_of_scope_upstream_conference_is_filtered_out(data):
    """exclude 指定の PL/形式手法系（popl 等）は収録されない。

    PRCV は 2026-08-10 の CG サブ分野収録拡大で graphics として収録対象に
    なったため、範囲外の例は exclude リストの代表に置き換えた。
    """
    keys = {c["key"] for c in data["conferences"]}
    assert "prcv" in keys  # CG 収録拡大で graphics として収録
    assert "popl" not in keys
    assert "oopsla" not in keys
    assert "aplas" not in keys


def test_ccfddl_plain_deadline_becomes_a_paper_deadline(data):
    sc26 = [e for e in _conf(data, "sc")["editions"] if e["id"] == "sc26"][0]
    kinds = {d["kind"] for d in sc26["deadlines"]}
    assert "paper" in kinds
    assert "abstract" in kinds


def test_aoe_boundary_is_converted_in_the_generated_data(data):
    """SC26 paper deadline '2026-04-08 23:59:00' AoE -> 2026-04-09T11:59:00Z."""
    sc26 = [e for e in _conf(data, "sc")["editions"] if e["id"] == "sc26"][0]
    paper = [d for d in sc26["deadlines"] if d["kind"] == "paper"]
    assert paper
    assert paper[0]["utc"] == "2026-04-09T11:59:00Z"
    assert paper[0]["tz_raw"].lower() == "aoe"
    assert paper[0]["aoe"].startswith("2026-04-08 23:59")


def test_free_text_event_dates_are_parsed(data):
    sigcomm26 = [
        e for e in _conf(data, "sigcomm")["editions"] if e["id"] == "sigcomm26"
    ][0]
    assert sigcomm26["event_start"] == "2026-08-17"
    assert sigcomm26["event_end"] == "2026-08-21"


def test_multiple_rounds_are_preserved(data):
    nsdi27 = [e for e in _conf(data, "nsdi")["editions"] if e["id"] == "nsdi27"][0]
    rounds = {(d["kind"], d["round"]) for d in nsdi27["deadlines"]}
    assert ("paper", 1) in rounds
    assert ("paper", 2) in rounds


def test_unparseable_deadline_is_skipped_not_fatal(data):
    """acl27's deadline is 'TBD'; it must not appear as a deadline."""
    keys = {c["key"] for c in data["conferences"]}
    if "acl" not in keys:
        pytest.skip("acl not selected by the current config")
    editions = {e["id"]: e for e in _conf(data, "acl")["editions"]}
    if "acl27" in editions:
        assert editions["acl27"]["deadlines"] == []


def test_no_deadline_is_in_the_far_future_by_accident(data):
    for conf in data["conferences"]:
        for ed in conf["editions"]:
            for dl in ed["deadlines"]:
                moment = datetime.strptime(dl["utc"], "%Y-%m-%dT%H:%M:%SZ").replace(
                    tzinfo=UTC
                )
                assert datetime(2015, 1, 1, tzinfo=UTC) <= moment
                assert moment <= datetime(2032, 1, 1, tzinfo=UTC)


# --- calendars -------------------------------------------------------------


def _events(site, name):
    from icalendar import Calendar

    cal = Calendar.from_ical((site / name).read_text(encoding="utf-8"))
    return cal.walk("VEVENT")


@pytest.mark.parametrize("name", ICS_FEEDS)
def test_every_feed_parses_with_icalendar(site, name):
    from icalendar import Calendar

    cal = Calendar.from_ical((site / name).read_text(encoding="utf-8"))
    assert cal.name == "VCALENDAR"
    for ev in cal.walk("VEVENT"):
        assert ev.get("UID")
        assert ev.get("DTSTART") is not None


def test_vevent_counts_match_data_json(site, data):
    expected_deadlines = 0
    expected_events = 0
    expected_estimated = 0
    for conf in data["conferences"]:
        for ed in conf["editions"]:
            if ed["estimated"]:
                expected_estimated += len(ed["deadlines"])
                continue
            expected_deadlines += len(ed["deadlines"])
            if ed["event_start"]:
                expected_events += 1

    assert len(_events(site, "deadlines.ics")) == expected_deadlines
    assert len(_events(site, "all-estimated.ics")) == expected_estimated
    assert len(_events(site, "all.ics")) == expected_deadlines + expected_events


def test_category_feeds_partition_all(site, data):
    everything = {str(e["UID"]) for e in _events(site, "all.ics")}
    union = set()
    for name in ("hpc.ics", "networking.ics", "systems.ics", "ai.ics", "security.ics"):
        uids = {str(e["UID"]) for e in _events(site, name)}
        assert uids <= everything, name
        union |= uids
    assert union <= everything


def test_feeds_use_crlf_and_fold_at_75_octets(site):
    for name in ICS_FEEDS:
        raw = (site / name).read_bytes()
        body = raw[:-2] if raw.endswith(b"\r\n") else raw
        for line in body.split(b"\r\n"):
            assert len(line) <= 75, f"{name}: {line!r}"
            line.decode("utf-8")


# --- other artefacts -------------------------------------------------------


def test_csv_is_one_row_per_deadline(site, data):
    text = (site / "data.csv").read_text(encoding="utf-8")
    rows = list(csv.DictReader(io.StringIO(text)))
    assert rows
    total = sum(
        len(ed["deadlines"]) for c in data["conferences"] for ed in c["editions"]
    )
    assert len(rows) in (total, total - sum(
        len(ed["deadlines"])
        for c in data["conferences"]
        for ed in c["editions"]
        if ed["estimated"]
    ))


def test_upcoming_md_is_a_table(site):
    text = (site / "upcoming.md").read_text(encoding="utf-8")
    assert "|" in text
    assert re.search(r"^\|?\s*-{3,}", text, re.M) or "---" in text


def test_llms_txt_indexes_the_feeds(site):
    text = (site / "llms.txt").read_text(encoding="utf-8")
    for name in ("all.ics", "data.json", "all-estimated.ics"):
        assert name in text, f"{name} not referenced from llms.txt"


def test_llms_txt_urls_match_the_published_site(site, repo_config):
    """The URLs llms.txt advertises are the only entry point an agent gets.

    They are built from site.base_url; if that is unset the feeds are announced
    at the domain root while the project pages live under the repository name,
    and every advertised URL 404s.
    """
    from .conftest import REPO_ROOT

    base = ((repo_config.get("site") or {}).get("base_url") or "").rstrip("/")
    assert base, "config.yaml の site.base_url が無い"

    urls = [
        line[2:].split(" ", 1)[0]
        for line in (site / "llms.txt").read_text(encoding="utf-8").splitlines()
        if line.startswith("- http")
    ]
    assert len(urls) >= len(ICS_FEEDS)
    assert all(u.startswith(base + "/") for u in urls), urls[:3]

    readme = REPO_ROOT / "README.md"
    if readme.is_file():
        text = readme.read_text(encoding="utf-8")
        for name in ("all.ics", "data.json", "llms.txt"):
            assert f"{base}/{name}" in text, f"README と llms.txt の URL が食い違う: {name}"


def test_index_html_has_the_data_injected(site):
    text = (site / "index.html").read_text(encoding="utf-8")
    assert "/*__DATA__*/null" not in text, "template placeholder was not replaced"
    assert "conferences" in text


def test_generated_at_follows_the_now_argument(site, tmp_path, run_cli):
    other = tmp_path / "public3"
    proc = run_cli(other, now="2027-01-02T00:00:00Z")
    assert proc.returncode == 0, proc.stderr
    payload = json.loads((other / "data.json").read_text(encoding="utf-8"))
    assert payload["generated_at"] == "2027-01-02T00:00:00Z"
    assert payload["generated_at"] != json.loads(
        (site / "data.json").read_text(encoding="utf-8")
    )["generated_at"]
    assert NOW_ARG == "2026-08-09T00:00:00Z" and NOW.year == 2026


# --- per-category estimated feeds (SPEC.md 4) ------------------------------

ESTIMATED_FEEDS = [f for f in ICS_FEEDS if f.endswith("-estimated.ics")]
CONFIRMED_FEEDS = [f for f in ICS_FEEDS if not f.endswith("-estimated.ics")]


def test_the_single_estimated_feed_is_gone(site):
    assert not (site / "estimated.ics").exists(), (
        "estimated.ics was replaced by all-estimated.ics and the per-category feeds"
    )


def test_every_category_has_its_own_estimated_feed(site):
    assert {
        "all-estimated.ics",
        "hpc-estimated.ics",
        "networking-estimated.ics",
        "systems-estimated.ics",
        "ai-estimated.ics",
        "security-estimated.ics",
    } <= set(ESTIMATED_FEEDS)
    for name in ESTIMATED_FEEDS:
        assert (site / name).exists(), name


@pytest.mark.parametrize("name", [f for f in ICS_FEEDS if f.endswith("-estimated.ics")])
def test_estimated_feeds_are_subsets_of_all_estimated(site, name):
    everything = {str(e["UID"]) for e in _events(site, "all-estimated.ics")}
    assert {str(e["UID"]) for e in _events(site, name)} <= everything


def test_estimated_feed_routes_by_category(site, data):
    """A networking estimate belongs in networking-estimated.ics and nowhere else."""
    expected = {}
    for conf in data["conferences"]:
        for ed in conf["editions"]:
            if not ed["estimated"]:
                continue
            for cat in conf["categories"]:
                expected.setdefault(cat, set()).add((conf["key"], ed["year"]))
    assert expected, "no estimated editions in the fixture build"
    for cat, pairs in expected.items():
        uids = {str(e["UID"]) for e in _events(site, f"{cat}-estimated.ics")}
        for key, year in pairs:
            assert any(u.startswith(f"{key}-{year}-") for u in uids), (cat, key, year)


@pytest.mark.parametrize("name", CONFIRMED_FEEDS)
def test_confirmed_feeds_carry_no_estimate(site, data, name):
    estimated = {
        f"{conf['key']}-{ed['year']}-"
        for conf in data["conferences"]
        for ed in conf["editions"]
        if ed["estimated"]
    }
    assert estimated, "no estimated editions in the fixture build"
    for event in _events(site, name):
        uid = str(event["UID"])
        assert not any(uid.startswith(p) for p in estimated), f"{name}: {uid}"


# --- meeting-only conferences reach the site (SPEC.md 7) -------------------


def test_conferences_without_deadlines_keep_their_meeting_dates(data):
    """ISC High Performance, HOTI and APNOMS have dates but no deadline."""
    for key in ("isc-hpc", "hoti", "apnoms"):
        conf = _conf(data, key)
        dated = [ed for ed in conf["editions"] if ed["event_start"]]
        assert dated, f"{key} has no edition with event_start"
        assert all(not ed["deadlines"] for ed in dated), (
            f"{key} is no longer a meeting-only conference; pick another example"
        )


def test_index_html_has_no_meeting_rows(site):
    """開催イベント行は生成しない。このサイトは投稿締切（概要・論文）のみを扱う。"""
    html = (site / "index.html").read_text(encoding="utf-8")
    assert 'event: "開催"' not in html, "開催 pseudo-kind は排除済みのはず"
    assert "KIND_LABEL[r.kind]" in html
    assert re.search(r'r\.kind !== "abstract" && r\.kind !== "paper"', html), (
        "投稿締切以外の行は filter で常に除外されるべき"
    )
    for title in ("ISC High Performance", "HOTI", "情報処理学会 HPC 研究会"):
        assert title in html, f"{title} is not in the embedded data"


def test_index_html_has_domestic_filter_and_tag(site):
    """国内研究会は通しやすい発表枠なので一覧から落とさず、専用フィルタで拾える。"""
    html = (site / "index.html").read_text(encoding="utf-8")
    assert 'id="domestic"' in html
    assert "domestic-jp" in html
    assert 'textContent = "国内"' in html
    assert 'p.get("domestic") === "1"' in html
    for title in (
        "情報処理学会 OS 研究会",
        "電子情報通信学会 NS 研究会",
        "電子情報通信学会 IA 研究会",
        "電子情報通信学会 CQ 研究会",
        "電子情報通信学会 ICM 研究会",
        "APNOMS",
        "FIT",
    ):
        assert title in html, f"{title} missing from embedded data"


# --- coincident deadlines are told apart (SPEC.md 3.6) ---------------------


def _summaries(text: str) -> list[str]:
    from .conftest import ics_property, unfold_ics

    return ics_property(unfold_ics(text), "SUMMARY")


def test_coincident_deadlines_get_distinguishable_titles(tmp_path, make_conf):
    """SIGGRAPH keeps three submission tracks at one instant; SPEC.md 3.6 rule 5.

    Without the label the three become three calendar entries reading
    'SIGGRAPH 2026 論文締切' at the same minute, which no client can tell apart.
    """
    from scripts.build import build_all

    at = datetime(2026, 9, 21, 22, 0, 0, tzinfo=UTC)  # after NOW, so it reaches upcoming.md
    conf = make_conf.conference(
        key="acm-siggraph",
        title="SIGGRAPH",
        categories=["ai"],
        sources=["aideadlines"],
        editions=[
            make_conf.edition(
                year=2026,
                edition_id="siggraph26",
                source="aideadlines",
                deadlines=[
                    make_conf.deadline("paper", "Posters deadline", at),
                    make_conf.deadline("paper", "Appy Hour deadline", at),
                    # a lone deadline at another instant keeps the plain title
                    make_conf.deadline(
                        "paper", "Technical Papers deadline",
                        datetime(2026, 10, 22, 22, 0, 0, tzinfo=UTC),
                    ),
                ],
            )
        ],
    )
    build_all([conf], {"categories": {"ai": "AI"}}, tmp_path, NOW)
    # bytes: read_text would fold CRLF away and unfolding would stop working
    summaries = _summaries((tmp_path / "all.ics").read_bytes().decode("utf-8"))
    assert sorted(summaries) == sorted([
        "SIGGRAPH 2026 論文締切: Appy Hour deadline",
        "SIGGRAPH 2026 論文締切: Posters deadline",
        "SIGGRAPH 2026 論文締切",
    ])
    assert len(set(summaries)) == len(summaries), "two entries share a title"
    upcoming = (tmp_path / "upcoming.md").read_text(encoding="utf-8")
    assert "論文締切: Posters deadline" in upcoming


# --- upcoming.md carries meetings too (SPEC.md 4) --------------------------


def _upcoming_rows(site) -> list[list[str]]:
    text = (site / "upcoming.md").read_text(encoding="utf-8")
    rows = []
    for line in text.splitlines():
        if not line.startswith("|") or set(line) <= set("|- "):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        rows.append(cells)
    return rows[1:]  # drop the header


def test_upcoming_md_lists_meetings_as_well_as_deadlines(site):
    """README points readers at upcoming.md first; a meeting-only conference
    (HOTI, the IPSJ SIG, P4 Workshop, LPC) is otherwise absent from it."""
    rows = _upcoming_rows(site)
    kinds = {r[3] for r in rows}
    assert "開催" in kinds, "no meeting row in upcoming.md"
    names = " ".join(r[2] for r in rows if r[3] == "開催")
    for title in ("HOTI 2026", "SC 2026", "情報処理学会 HPC 研究会 2026",
                  "P4 Workshop 2026", "LPC 2026"):
        assert title in names, f"{title} is missing from upcoming.md"


def test_upcoming_md_keeps_a_running_meeting_and_drops_a_finished_one(
    tmp_path, make_conf
):
    """The meeting rule is end-of-last-day, not start-of-first-day."""
    from scripts.build import build_all

    def meeting(key, start, end):
        return make_conf.conference(
            key=key, title=key.upper(), categories=["hpc"], sources=["local"],
            editions=[make_conf.edition(
                year=2026, edition_id=f"{key}26", source="local",
                event_start=start, event_end=end,
            )],
        )

    confs = [
        meeting("running", date(2026, 8, 7), date(2026, 8, 11)),
        meeting("lastday", date(2026, 8, 5), date(2026, 8, 9)),
        meeting("finished", date(2026, 8, 1), date(2026, 8, 8)),
        meeting("future", date(2026, 8, 19), date(2026, 8, 21)),
    ]
    build_all(confs, {"categories": {"hpc": "HPC"}}, tmp_path, NOW)  # NOW = 2026-08-09
    text = (tmp_path / "upcoming.md").read_text(encoding="utf-8")
    assert "開催中(残り3日)" in text, "a running meeting must stay listed"
    assert "| 本日開催 |" not in text or "LASTDAY" in text
    assert "開催中(残り1日)" in text, "the last day is still 'running'"
    assert "FINISHED" not in text, "a meeting whose last day passed must drop out"
    assert "| 10日 |" in text, "a future meeting counts down in whole days"


# --- the site's meeting rows run to the end of the meeting (SPEC.md 7) -----


def _js_function(html: str, name: str) -> str:
    """The source text of a top-level ``function <name>(...) {...}`` block."""
    start = html.index(f"function {name}(")
    depth, i = 0, html.index("{", start)
    while True:
        if html[i] == "{":
            depth += 1
        elif html[i] == "}":
            depth -= 1
            if depth == 0:
                return html[start : i + 1]
        i += 1


def test_default_filter_shows_only_submission_deadlines(site, tmp_path):
    """デフォルト（kind 未選択）は投稿締切（abstract/paper）のみ表示。開催・通知等は kind 明示時のみ。"""
    import json as _json
    import shutil
    import subprocess

    node = shutil.which("node")
    if node is None:
        pytest.skip("node is not installed")
    html = (site / "index.html").read_text(encoding="utf-8")
    script = tmp_path / "probe_default.js"
    script.write_text(
        "const DAY = 86400000;\n"
        "const FILTER = %s;\n" % _json.dumps(_js_function(html, "filter"))
        + """
const now = Date.parse("2026-08-10T00:00:00Z");
function row(kind) {
  return {
    kind: kind, est: false, cats: ["hpc"], rankPairs: [], hay: "x",
    t: now + 86400000, tLast: now + 2 * 86400000, ed: { deadlines: [] }
  };
}
const rows = ["paper", "abstract", "event", "notification", "camera_ready"].map(row);
const state = { q: "", cats: [], kind: "", rank: "", win: "all", est: false };
const filter = new Function("Date", "DAY", "rows", "state", "sortAsc", "sortKey",
                            "return (" + FILTER + ")")(Date, DAY, rows, state, false, "time");
console.log(JSON.stringify(filter().map(r => r.kind)));
"""
    )
    proc = subprocess.run([node, str(script)], capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, proc.stderr
    assert _json.loads(proc.stdout) == ["paper", "abstract"]


def test_meeting_past_rule_is_wired_to_the_end_date(site):
    """開催行は生成されない（投稿締切のみのサイト）。tLast 由来の event 行が
    復活しないことを構造的にガードする。"""
    html = (site / "index.html").read_text(encoding="utf-8")
    assert "kind: \"event\"" not in html, "event 行の生成コードが復活している"
    assert 'event: "開催"' not in html, "開催 pseudo-kind が復活している"


def test_two_meetings_in_one_year_get_distinct_event_uids(site):
    """SPEC.md 4.1: the IPSJ DPS SIG meets twice in 2026.  Ordinal 1 carries no
    suffix, so a once-a-year conference keeps the UID it always had.
    (開催日は events.ics を廃止したため all.ics で検証する)"""
    uids = {str(e["UID"]) for e in _events(site, "all.ics")}
    assert "ipsj-sigdps-2026-event@conf-deadlines.github.io" in uids
    assert "ipsj-sigdps-2026-event-2@conf-deadlines.github.io" in uids
    assert "sigcomm-2026-event@conf-deadlines.github.io" in uids
    assert "sigcomm-2026-event-1@conf-deadlines.github.io" not in uids
