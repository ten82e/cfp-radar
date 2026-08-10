"""Recommender (site/recommender.js) の回帰テスト。

実データ public/data.json と Node.js で JS ロジックを実走させて検証する。
Node が無い環境では fail-closed に FAIL する（スキップにしない）。
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
RECOMMENDER_JS = ROOT / "site" / "recommender.js"
DATA_JSON = ROOT / "public" / "data.json"

NODE = shutil.which("node")
if NODE is None:
    pytest.fail("node が無い。recommender.js は実走できず fail-closed で FAIL する")
assert NODE is not None  # Pyright 用: 上の pytest.fail で実行時は必ず止まる


def _run_node(script: str) -> str:
    """recommender.js を require 済みの状態で node スクリプトを実行する。"""
    code = (
        f"const R = require({str(RECOMMENDER_JS)!r});\n" + script
    )
    proc = subprocess.run(
        [NODE, "-e", code],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode == 0, f"node exited {proc.returncode}: {proc.stderr}\n{proc.stdout}"
    return proc.stdout


def _load_rows() -> list[dict]:
    """data.json から template.html の rows 相当（r.conf / r.cats）を組み立てる。"""
    data = json.loads(DATA_JSON.read_text(encoding="utf-8"))
    rows = []
    for conf in data["conferences"]:
        rows.append(
            {
                "conf": {
                    "key": conf.get("key", ""),
                    "title": conf.get("title", ""),
                    "full_name": conf.get("full_name", ""),
                    "tags": conf.get("tags", []),
                },
                "cats": conf.get("categories", []),
            }
        )
    return rows


def _make_test_script(rows: list[dict], papers: str, top_n: int = 10) -> str:
    """rows を JSON で埋め込み、全会議をスコア降順に並べ上位 N を出力するスクリプト。"""
    rows_json = json.dumps(rows, ensure_ascii=False)
    papers_json = json.dumps(papers, ensure_ascii=False)
    return f"""
const rows = {rows_json};
const papers = {papers_json};
const lines = R.parsePaperLines(papers);
const cats = R.autoDetectCats(lines);
const scored = rows.map(r => ({{
  key: r.conf.key,
  score: R.scorePapers(r, lines),
  hit: R.breakdown(r, lines).venueHit
}})).filter(x => x.score >= 10).sort((a, b) => b.score - a.score);
console.log("CATS=" + JSON.stringify(cats));
console.log("TOP=" + JSON.stringify(scored.slice(0, {top_n})));
console.log("N=" + scored.length);
"""


# ---- 純粋関数テスト ----

def test_parse_paper_lines_pipe_and_tab():
    out = _run_node("""
const lines = R.parsePaperLines(
  "Title A | kw1, kw2 | RTSS\\n" +
  "Title B | kw3\\n" +
  "Title C\\tkw4\\tFAST\\n" +
  "\\n" +
  "Title D"
);
console.log(JSON.stringify(lines));
""")
    lines = json.loads(out.strip())
    assert lines[0] == {"title": "Title A", "keywords": "kw1, kw2", "venue": "RTSS"}
    assert lines[1] == {"title": "Title B", "keywords": "kw3", "venue": ""}
    assert lines[2] == {"title": "Title C", "keywords": "kw4", "venue": "FAST"}
    assert lines[3] == {"title": "Title D", "keywords": "", "venue": ""}
    assert len(lines) == 4


def test_parse_paper_lines_empty():
    out = _run_node('console.log(JSON.stringify(R.parsePaperLines("  \\n\\n ")));')
    assert json.loads(out.strip()) == []


def test_auto_detect_cats_networking():
    out = _run_node("""
const lines = R.parsePaperLines(
  "Credit-Based Shaping for Deterministic Latency in TSN | TSN, CBS, network, protocol, wireless, routing"
);
console.log(JSON.stringify(R.autoDetectCats(lines)));
""")
    cats = json.loads(out.strip())
    assert cats[0] == "networking"


def test_auto_detect_cats_tsn_includes_systems():
    """TSN は networking と systems（real-time）の両方に判定される"""
    out = _run_node("""
const lines = R.parsePaperLines(
  "Credit-Based Shaping for Deterministic Latency in TSN | TSN, CBS, real-time, embedded, network"
);
console.log(JSON.stringify(R.autoDetectCats(lines)));
""")
    cats = json.loads(out.strip())
    assert "networking" in cats
    assert "systems" in cats


def test_auto_detect_cats_empty():
    out = _run_node("""
console.log(JSON.stringify(R.autoDetectCats([])));
""")
    assert json.loads(out.strip()) == []


def test_venue_hit_boosts_exact_conference():
    """掲載先タグ一致でその会議が top に来る（投票が効いている）"""
    rows = [
        {"conf": {"key": "rtss", "title": "RTSS", "full_name": "IEEE Real-Time Systems Symposium", "tags": ["real-time"]}, "cats": ["networking"]},
        {"conf": {"key": "sigcomm", "title": "SIGCOMM", "full_name": "ACM SIGCOMM", "tags": []}, "cats": ["networking"]},
        {"conf": {"key": "fast", "title": "FAST", "full_name": "USENIX FAST", "tags": ["storage"]}, "cats": ["systems"]},
    ]
    script = _make_test_script(rows, "Paper on TSN scheduling | network, protocol, real-time | RTSS")
    out = _run_node(script)
    top = json.loads(out.split("TOP=")[1].splitlines()[0])
    assert top[0]["key"] == "rtss"
    assert top[0]["hit"] is True


def test_no_venue_tag_no_hit():
    rows = [
        {"conf": {"key": "rtss", "title": "RTSS", "full_name": "IEEE Real-Time Systems Symposium", "tags": ["real-time"]}, "cats": ["networking"]},
    ]
    script = _make_test_script(rows, "Paper on TSN scheduling | network, protocol, real-time")
    out = _run_node(script)
    top = json.loads(out.split("TOP=")[1].splitlines()[0])
    assert top[0]["hit"] is False


# ---- pickRepresentative / comparePapers（論文モードの並び・集約） ----


def test_pick_representative_prefers_future_deadline_over_past():
    """同一会議に過去締切と未来締切があるとき未来を代表にする"""
    import datetime as _dt

    def _parse(iso: str) -> int:
        return int(_dt.datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000)

    out = _run_node("""
const now = Date.parse("2026-08-10T00:00:00Z");
const rows = [
  { conf: { key: "rtss" }, kind: "paper", t: Date.parse("2026-05-22T23:59:59Z"), tLast: Date.parse("2026-05-22T23:59:59Z") },
  { conf: { key: "rtss" }, kind: "paper", t: Date.parse("2027-05-20T23:59:59Z"), tLast: Date.parse("2027-05-20T23:59:59Z") }
];
const picked = R.pickRepresentative(rows, now);
console.log(JSON.stringify(picked.map(p => p.t)));
""")
    picked_ts = json.loads(out.strip())
    assert picked_ts == [_parse("2027-05-20T23:59:59Z")]


def test_pick_representative_prefers_deadline_over_event():
    out = _run_node("""
const now = Date.parse("2026-08-10T00:00:00Z");
const rows = [
  { conf: { key: "foo" }, kind: "event", t: Date.parse("2026-08-15T00:00:00Z"), tLast: Date.parse("2026-08-17T00:00:00Z") },
  { conf: { key: "foo" }, kind: "paper", t: Date.parse("2026-09-01T23:59:59Z"), tLast: Date.parse("2026-09-01T23:59:59Z") }
];
const picked = R.pickRepresentative(rows, now);
console.log(JSON.stringify(picked.map(p => p.kind)));
""")
    assert json.loads(out.strip()) == ["paper"]


def test_pick_representative_keeps_distinct_venues():
    out = _run_node("""
const now = Date.parse("2026-08-10T00:00:00Z");
const rows = [
  { conf: { key: "a" }, kind: "paper", t: now + 1 },
  { conf: { key: "b" }, kind: "paper", t: now + 2 }
];
console.log(JSON.stringify(R.pickRepresentative(rows, now).map(p => p.conf.key).sort()));
""")
    assert json.loads(out.strip()) == ["a", "b"]


def test_compare_papers_future_first_on_tie():
    out = _run_node("""
const now = Date.parse("2026-08-10T00:00:00Z");
const past = { _matchScore: 50, kind: "paper", t: Date.parse("2026-06-01T00:00:00Z"), tLast: Date.parse("2026-06-01T00:00:00Z") };
const future = { _matchScore: 50, kind: "paper", t: Date.parse("2026-12-01T00:00:00Z"), tLast: Date.parse("2026-12-01T00:00:00Z") };
const higher = { _matchScore: 60, kind: "paper", t: Date.parse("2026-06-01T00:00:00Z"), tLast: Date.parse("2026-06-01T00:00:00Z") };
console.log(JSON.stringify([
  R.comparePapers(past, future, now) > 0,   // future が先
  R.comparePapers(future, past, now) < 0,
  R.comparePapers(higher, future, now) < 0, // スコア優先
]));
""")
    assert json.loads(out.strip()) == [True, True, True]


def test_venue_categories_from_tag():
    """RTSS タグ → systems カテゴリが推定される"""
    out = _run_node("""
const lines = R.parsePaperLines("Paper A | kw | RTSS");
const rows = [
  { conf: { key: "rtss", title: "RTSS", full_name: "IEEE Real-Time Systems Symposium" }, cats: ["systems"] },
  { conf: { key: "sigcomm", title: "SIGCOMM", full_name: "ACM SIGCOMM" }, cats: ["networking"] }
];
console.log(JSON.stringify(R.venueCategories(lines, rows).sort()));
""")
    assert json.loads(out.strip()) == ["systems"]


def test_venue_categories_empty_without_tag():
    out = _run_node("""
const lines = R.parsePaperLines("Paper A | kw");
const rows = [{ conf: { key: "rtss", title: "RTSS", full_name: "IEEE Real-Time Systems Symposium" }, cats: ["systems"] }];
console.log(JSON.stringify(R.venueCategories(lines, rows)));
""")
    assert json.loads(out.strip()) == []


# ---- セマンティック（埋め込み） ----


def test_cosine_identical_and_orthogonal():
    out = _run_node("""
const a = [1, 0, 0], b = [0, 1, 0], c = [2, 0, 0];
console.log(JSON.stringify([
  R.cosine(a, c),        // 同じ方向 → 1
  R.cosine(a, b),        // 直交 → 0
  R.cosine([], a),       // 空 → 0
  R.cosine(null, a)      // null → 0
]));
""")
    res = json.loads(out.strip())
    assert res[0] == 1
    assert res[1] == 0
    assert res[2] == 0
    assert res[3] == 0


def test_semantic_score_scaling():
    """cosine 0.2 以下は 0、1.0 で 100 にスケーリングされる"""
    out = _run_node("""
const emb = {
  "same": [1, 0, 0],
  "partial": [0.8, 0.6, 0],
  "orth": [0, 1, 0]
};
const q = [1, 0, 0];
console.log(JSON.stringify([
  R.semanticScore("same", q, emb),    // cosine=1 → 100
  R.semanticScore("orth", q, emb),    // cosine=0 → 0
  R.semanticScore("missing", q, emb), // キー無し → 0
  R.semanticScore("same", null, emb)  // query 無し → 0
]));
""")
    res = json.loads(out.strip())
    assert res[0] == 100
    assert res[1] == 0
    assert res[2] == 0
    assert res[3] == 0
    assert 0 < res[0]


def test_query_text_joins_lines():
    out = _run_node("""
const lines = R.parsePaperLines("Paper A | kw1, kw2 | RTSS\\nPaper B | kw3");
console.log(JSON.stringify(R.queryText(lines)));
""")
    assert json.loads(out.strip()) == "Paper A kw1, kw2 Paper B kw3"


@pytest.mark.skipif(not DATA_JSON.is_file(), reason="public/data.json が無い（build 未実行）")
def test_embeddings_json_exists_and_covers_conferences():
    """embeddings.json が build で生成され、全会議をカバーしている"""
    emb_path = ROOT / "public" / "embeddings.json"
    if not emb_path.is_file():
        pytest.skip("embeddings.json 未生成（fastembed 依存のため）")
    emb = json.loads(emb_path.read_text(encoding="utf-8"))
    data = json.loads(DATA_JSON.read_text(encoding="utf-8"))
    keys = {c["key"] for c in data["conferences"]}
    emb_keys = set(emb.get("embeddings", {}))
    assert keys <= emb_keys, f"埋め込みが無い会議: {sorted(keys - emb_keys)[:5]}"
    dims = {len(v) for v in emb["embeddings"].values()}
    assert dims == {emb["dim"]}, f"次元が不揃い: {dims}"


# ---- 実データ統合テスト ----

@pytest.mark.skipif(not DATA_JSON.is_file(), reason="public/data.json が無い（build 未実行）")
def test_real_data_tsn_paper_finds_real_time_venues():
    rows = _load_rows()
    papers = (
        "投稿予定: Credit-Based Shaping for Deterministic Latency in Time-Sensitive Networking | "
        "TSN, CBS, latency, scheduling, Ethernet, real-time\n"
        "似た論文: Design and Analysis of Credit-Based Shapers in TSN | TSN, CBS, QoS | RTSS\n"
        "似た論文: Low-Latency Scheduling for Time-Sensitive Networks | scheduling, latency | IWQoS"
    )
    script = _make_test_script(rows, papers, top_n=8)
    out = _run_node(script)
    cats = json.loads(out.split("CATS=")[1].splitlines()[0])
    top = json.loads(out.split("TOP=")[1].splitlines()[0])
    # 分野自動判定が networking を含む
    assert "networking" in cats
    # RTSS（掲載先タグ）が top 圏内に来る
    keys = [t["key"] for t in top]
    assert any("rtss" in k for k in keys), f"RTSS not in top: {keys}"
    # 掲載先一致フラグが立っている会議が存在する
    assert any(t["hit"] for t in top)


@pytest.mark.skipif(not DATA_JSON.is_file(), reason="public/data.json が無い（build 未実行）")
def test_real_data_storage_paper_lands_systems():
    rows = _load_rows()
    papers = (
        "A Scalable Log-Structured Storage Engine for Multitenant Cloud Servers | "
        "storage, log-structured, cloud, multitenant, scalability\n"
        "The Design of a Log-Structured File System | log-structured, filesystem, storage | FAST"
    )
    script = _make_test_script(rows, papers, top_n=8)
    out = _run_node(script)
    cats = json.loads(out.split("CATS=")[1].splitlines()[0])
    top = json.loads(out.split("TOP=")[1].splitlines()[0])
    assert "systems" in cats
    keys = [t["key"] for t in top]
    assert any("fast" in k for k in keys), f"FAST not in top: {keys}"


@pytest.mark.skipif(not DATA_JSON.is_file(), reason="public/data.json が無い（build 未実行）")
def test_real_data_no_papers_no_match():
    rows = _load_rows()
    out = _run_node(_make_test_script(rows, "", top_n=5))
    assert out.strip() == "CATS=[]\nTOP=[]\nN=0"


@pytest.mark.skipif(not DATA_JSON.is_file(), reason="public/data.json が無い（build 未実行）")
def test_real_data_security_paper_lands_top_tier():
    """セキュリティ論文 → S&P / USENIX Security / CCS が上位に来る"""
    rows = _load_rows()
    papers = (
        "Post-Quantum Key Exchange for Encrypted Network Traffic | security, crypto, encryption, privacy, attack\n"
        "SoK: Hardware-Enforced Memory Isolation | security, enclave, sgx, memory | IEEE Symposium on Security & Privacy"
    )
    script = _make_test_script(rows, papers, top_n=10)
    out = _run_node(script)
    cats = json.loads(out.split("CATS=")[1].splitlines()[0])
    top = json.loads(out.split("TOP=")[1].splitlines()[0])
    assert "security" in cats
    keys = " ".join(t["key"] for t in top)
    # IEEE S&P / USENIX Security / CCS のいずれかが上位に来る（タグ投票で S&P が必ず入る）
    assert any(x in keys for x in ["ieee-symposium-on-security", "usenix-security", "ccs"]), f"top: {keys}"


@pytest.mark.skipif(not DATA_JSON.is_file(), reason="public/data.json が無い（build 未実行）")
def test_real_data_ml_paper_lands_neurips_icml():
    rows = _load_rows()
    papers = (
        "Scaling Laws for Transformer Language Models | transformer, llm, deep learning, neural, machine learning\n"
        "Diffusion Models for Generative Image Synthesis | diffusion, generative, image | NeurIPS"
    )
    script = _make_test_script(rows, papers, top_n=10)
    out = _run_node(script)
    cats = json.loads(out.split("CATS=")[1].splitlines()[0])
    top = json.loads(out.split("TOP=")[1].splitlines()[0])
    assert "ai" in cats
    keys = [t["key"] for t in top]
    assert any("neurips" in k for k in keys), f"NeurIPS not in top: {keys}"


@pytest.mark.skipif(not DATA_JSON.is_file(), reason="public/data.json が無い（build 未実行）")
def test_real_data_venue_tag_beats_generic_category_noise():
    """タグ付き掲載先（RTSS）は、カテゴリ一致だけの無関係会議（ASAP 等）より明確に上位"""
    rows = _load_rows()
    papers = (
        "投稿予定: Credit-Based Shaping for Deterministic Latency in TSN | TSN, CBS, latency, scheduling, Ethernet, real-time\n"
        "似た論文: Design and Analysis of Credit-Based Shapers in TSN | TSN, CBS, QoS | RTSS"
    )
    script = _make_test_script(rows, papers, top_n=12)
    out = _run_node(script)
    top = json.loads(out.split("TOP=")[1].splitlines()[0])
    scores = {t["key"]: t["score"] for t in top}
    # RTSS（掲載先一致）は systems カテゴリだけの会議（asap/ase/apsys）より必ず上
    assert scores.get("rtss", 0) > scores.get("asap", 0), f"scores: {scores}"
    assert scores.get("rtss", 0) > scores.get("ase", 0), f"scores: {scores}"
    # 掲載先一致タグが付いている
    rtss = next(t for t in top if t["key"] == "rtss")
    assert rtss["hit"] is True


@pytest.mark.skipif(not DATA_JSON.is_file(), reason="public/data.json が無い（build 未実行）")
def test_real_data_short_venue_tag_sc_matches():
    """2 文字タグ（SC）は key 完全一致で掲載先として効く"""
    rows = _load_rows()
    papers = (
        "Scheduling Large-Scale MPI Jobs on Heterogeneous Supercomputers | HPC, MPI, scheduling, cluster, GPU\n"
        "Supercomputing Interconnect for Exascale Systems | interconnect, HPC, network | SC"
    )
    script = _make_test_script(rows, papers, top_n=12)
    out = _run_node(script)
    top = json.loads(out.split("TOP=")[1].splitlines()[0])
    sc = next((t for t in top if t["key"] == "sc"), None)
    assert sc is not None, f"SC not in top: {[t['key'] for t in top]}"
    assert sc["hit"] is True
    # SC は cluster より上（掲載先一致のため）
    cluster = next((t for t in top if t["key"] == "cluster"), None)
    if cluster:
        assert sc["score"] > cluster["score"]


@pytest.mark.skipif(not DATA_JSON.is_file(), reason="public/data.json が無い（build 未実行）")
def test_real_data_japanese_paper_finds_japanese_venues():
    """日本語論文 → 国内研究会（日本語会議名と部分一致）が無関係会議より上位"""
    rows = _load_rows()
    papers = "分散システムにおける低遅延ミドルウェア | 分散, ミドルウェア, 低遅延, システム"
    script = _make_test_script(rows, papers, top_n=12)
    out = _run_node(script)
    top = json.loads(out.split("TOP=")[1].splitlines()[0])
    scores = {t["key"]: t["score"] for t in top}
    # 日本語会議名（comsys/ipsj-sigarc/ipsj-sigos 等）が拾われる
    jp_hits = [t["key"] for t in top if t["score"] >= 20]
    assert len(jp_hits) >= 1, f"no Japanese venue above 20: {scores}"
    # 無関係の英語 systems 会議（asap/ase）より上
    assert max(scores.get(k, 0) for k in jp_hits) > scores.get("asap", 0), f"scores: {scores}"


# ---- 論文モード統合（filter の論文モード相当の動作契約） ----


@pytest.mark.skipif(not DATA_JSON.is_file(), reason="public/data.json が無い（build 未実行）")
def test_paper_mode_pipeline_future_only_and_dedupes():
    """論文モード: 過去行は完全に除外され、未来の投稿可能会議のみがスコア順に集約される"""
    rows = _load_rows()
    papers = (
        "Credit-Based Shaping for Deterministic Latency in TSN | TSN, CBS, latency, real-time\n"
        "Similar Paper on TSN Scheduling | scheduling, TSN | RTSS"
    )
    script = f"""
const fs = require("fs");
const data = JSON.parse(fs.readFileSync("{DATA_JSON}", "utf8"));
const NOW = Date.parse("2026-08-10T00:00:00Z");
const DAY = 86400000;
const rows = [];
for (const c of data.conferences) {{
  for (const ed of c.editions || []) {{
    for (const dl of ed.deadlines || []) {{
      rows.push({{ conf: c, ed: ed, cats: c.categories || [], key: c.key, kind: dl.kind || "deadline",
        t: Date.parse(dl.utc), tLast: Date.parse(dl.utc), est: !!(dl.estimated || ed.estimated),
        rankPairs: [], name: c.title, year: ed.year }});
    }}
  }}
}}
const pLines = R.parsePaperLines({json.dumps(papers)});
const venueCats = R.venueCategories(pLines, rows);

let out = rows.filter(r => r.t >= NOW).map(r => {{
  const m = R.breakdown(r, pLines);
  let score = m.score;
  if (!m.venueHit && venueCats.length) {{
    const shared = (r.cats || []).some(k => venueCats.indexOf(k) >= 0);
    if (shared) score = Math.min(100, score + 10);
  }}
  r._matchScore = score;
  return r;
}}).filter(r => r._matchScore >= 10);
out.sort((a, b) => R.comparePapers(a, b, NOW));
out = R.pickRepresentative(out, NOW);

const hasPast = out.some(r => r.kind !== "event" && r.t < NOW);
const keys = out.map(r => r.conf.key);
const unique = new Set(keys).size === keys.length;
const sorted = out.every((r, i) => i === 0 || out[i-1]._matchScore >= r._matchScore);
const rtasIdx = keys.indexOf("rtas");

console.log(JSON.stringify({{ hasPast, unique, sorted, n: out.length, rtasIdx,
  top: out.slice(0, 3).map(r => r.conf.key + ":" + r._matchScore) }}));
"""
    out = _run_node(script)
    res = json.loads(out.strip())
    assert not res["hasPast"], "過去行が残っている"
    assert res["unique"], "会議単位に集約されていない"
    assert res["sorted"], "スコア降順になっていない"
    assert 0 <= res["rtasIdx"] < 3, f"RTAS が上位にない: {res['top']}"



