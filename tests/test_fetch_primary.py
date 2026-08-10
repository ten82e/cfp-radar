"""fetch_primary.py の抽出ロジックの最小テスト。"""

from scripts.fetch_primary import extract_deadline, extract_deadlines, page_year, to_lines


def test_easychair_style():
    # SETTA 2026 の実例: "Submission deadline May 10, 2026"
    got = extract_deadline("Submission deadline May 10, 2026", year=2026)
    assert got == {
        "kind": "paper",
        "label": "Paper submission",
        "date": "2026-05-10",
        "tz": None,
        "round": 1,
    }


def test_abstract_with_round_and_tz():
    got = extract_deadline("Abstract submission (Round 2) deadline: Aug 16, 2026 (AoE)", year=2026)
    assert got is not None
    assert got["kind"] == "abstract"
    assert got["round"] == 2
    assert got["tz"] == "AoE"
    assert got["date"] == "2026-08-16"
    assert got["label"] == "Round 2 Abstract submission"


def test_ignore_stale_year():
    # 2 年前の残骸 (2024) は 2026 edition に拾わない。
    # (前年 2025 は 1 月開催会議の締切であり得るので有効)
    assert extract_deadline("Paper submission deadline: August 21, 2024", year=2026) is None


def test_page_year_from_title():
    assert page_year("<title>SETTA 2026: International Symposium on ...</title>", default=2026) == 2026
    # レジストリが 2027 なのに title が古い版のまま → default が勝つ
    assert page_year("<title>SETTA 2025 (archived)</title>", default=2026) == 2026
    # title に年が無い
    assert page_year("<title>Call for Papers</title>", default=2026) == 2026
    # 未来版の誤検出防止
    assert page_year("<title>SETTA 2030</title>", default=2026) == 2026


def test_no_keyword_is_none():
    # deadline キーワードが無い裸の日付は抽出しない
    assert extract_deadline("Registration opens January 5, 2026", year=2026) is None


def test_camera_ready():
    got = extract_deadline("Camera-ready deadline: October 3, 2026 23:59 UTC", year=2026)
    assert got is not None
    assert got["kind"] == "camera_ready"
    assert got["tz"] == "UTC"


def test_to_lines_splits_cells():
    html = "<table><tr><td>Submission deadline</td><td>Aug 16, 2026</td></tr></table>"
    lines = to_lines(html)
    assert "Submission deadline" in lines
    assert "Aug 16, 2026" in lines


def test_extract_deadlines_window():
    lines = [
        "All deadlines refer to AoE.",
        "Paper submission deadline: August 21, 2026",
        "Notification: October 15, 2026",
    ]
    got = extract_deadlines(lines, year=2026)
    kinds = {g["kind"] for g in got}
    assert kinds == {"paper", "notification"}
    paper = next(g for g in got if g["kind"] == "paper")
    assert paper["tz"] == "AoE"  # 前の行の AoE をウィンドウで拾う
