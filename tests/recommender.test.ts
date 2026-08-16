/**
 * Recommender (site/recommender.js) の回帰テスト。
 * Ported from tests/test_recommender.py（Node 実走の部分を vitest に置換）。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// recommender.js は UMD（module.exports あり、DOM 非依存）。型宣言なしのプレーン JS。
// @ts-expect-error - no declaration file for plain-JS recommender.js
import recommender from "../site/recommender.js";
import { contentWords, norm, parseBenchArgs, topicWords } from "../src/bench-recommender.ts";
import { venuePapersHash } from "../src/embeddings.ts";
import { REPO_ROOT } from "./helpers.ts";

const R = recommender as any;
const DATA_JSON = join(REPO_ROOT, "public", "data.json");
const EMB_JSON = join(REPO_ROOT, "public", "embeddings.json");
const hasData = (() => {
  try {
    return readFileSync(DATA_JSON, "utf8").length > 0;
  } catch {
    return false;
  }
})();

function loadRows(): any[] {
  const data = JSON.parse(readFileSync(DATA_JSON, "utf8"));
  return data.conferences.map((conf: any) => ({
    conf: {
      key: conf.key ?? "",
      title: conf.title ?? "",
      full_name: conf.full_name ?? "",
      tags: conf.tags ?? [],
    },
    cats: conf.categories ?? [],
  }));
}

// ---- 純粋関数テスト ----

describe("parsePaperLines", () => {
  it("handles pipe and tab separators", () => {
    const lines = R.parsePaperLines(
      "Title A | kw1, kw2 | RTSS\n" + "Title B | kw3\n" + "Title C\tkw4\tFAST\n" + "\n" + "Title D",
    );
    expect(lines[0]).toEqual({ title: "Title A", keywords: "kw1, kw2", venue: "RTSS" });
    expect(lines[1]).toEqual({ title: "Title B", keywords: "kw3", venue: "" });
    expect(lines[2]).toEqual({ title: "Title C", keywords: "kw4", venue: "FAST" });
    expect(lines[3]).toEqual({ title: "Title D", keywords: "", venue: "" });
    expect(lines.length).toBe(4);
  });

  it("handles empty input", () => {
    expect(R.parsePaperLines("  \n\n ")).toEqual([]);
  });
});

describe("autoDetectCats", () => {
  it("detects networking", () => {
    const cats = R.autoDetectCats(
      R.parsePaperLines(
        "Credit-Based Shaping for Deterministic Latency in TSN | TSN, CBS, network, protocol, wireless, routing",
      ),
    );
    expect(cats[0]).toBe("networking");
  });

  it("TSN includes systems", () => {
    // TSN は networking と systems（real-time）の両方に判定される
    const cats = R.autoDetectCats(
      R.parsePaperLines(
        "Credit-Based Shaping for Deterministic Latency in TSN | TSN, CBS, real-time, embedded, network",
      ),
    );
    expect(cats).toContain("networking");
    expect(cats).toContain("systems");
  });

  it("empty input yields no categories", () => {
    expect(R.autoDetectCats([])).toEqual([]);
  });
});

describe("name matching stopwords", () => {
  it("generic words like processing do not match conference names", () => {
    // Signal Processing 等の会議名に含まれる一般語が内容語として加点されない
    const rows = [
      {
        conf: {
          key: "icassp",
          title: "ICASSP",
          full_name: "IEEE International Conference on Acoustics, Speech, and Signal Processing",
        },
        cats: [],
      },
    ];
    const lines = R.parsePaperLines(
      "Kubernetes Service Mesh with eBPF-based Packet Processing | kubernetes, ebpf, network, packet",
    );
    const b = R.breakdown(rows[0], lines);
    expect(b.agg.name).toBe(0);
    expect(b.score).toBe(0); // 分野なし・会議名一致なし → 推薦されない
  });
});

describe("venue hit", () => {
  const rows = [
    {
      conf: {
        key: "rtss",
        title: "RTSS",
        full_name: "IEEE Real-Time Systems Symposium",
        tags: ["real-time"],
      },
      cats: ["networking"],
    },
    {
      conf: { key: "sigcomm", title: "SIGCOMM", full_name: "ACM SIGCOMM", tags: [] },
      cats: ["networking"],
    },
    {
      conf: { key: "fast", title: "FAST", full_name: "USENIX FAST", tags: ["storage"] },
      cats: ["systems"],
    },
  ];
  const run = (papers: string): any[] => {
    const lines = R.parsePaperLines(papers);
    return rows
      .map((r) => ({
        key: r.conf.key,
        score: R.scorePapers(r, lines),
        hit: R.breakdown(r, lines).venueHit,
      }))
      .filter((x) => x.score >= 10)
      .sort((a, b) => b.score - a.score);
  };

  it("boosts exact conference to the top", () => {
    // 掲載先タグ一致でその会議が top に来る（投票が効いている）
    const top = run("Paper on TSN scheduling | network, protocol, real-time | RTSS");
    expect(top[0].key).toBe("rtss");
    expect(top[0].hit).toBe(true);
  });

  it("no venue tag no hit", () => {
    const top = run("Paper on TSN scheduling | network, protocol, real-time");
    expect(top[0].hit).toBe(false);
  });
});

// ---- pickRepresentative / comparePapers（論文モードの並び・集約） ----

const NOW = Date.parse("2026-08-10T00:00:00Z");

describe("sig weights (R11: サブシグナル実測スイープ対応)", () => {
  const jpRow = {
    conf: {
      key: "ipsj-sigdps",
      title: "情報処理学会 DPS 研究会",
      full_name: "情報処理学会 マルチメディア通信と分散処理研究会 (SIGDPS)",
      tags: [],
    },
    cats: ["networking"],
  };

  it("jp signal defaults to 30 (double the R1-era 15)", () => {
    const b = R.breakdown(
      jpRow,
      R.parsePaperLines("モバイルエッジ向け分散処理ミドルウェア | 分散処理, モバイル, エッジ"),
    );
    expect(b.agg.jp).toBe(30);
  });

  it("generic metadata tags (journal/workshop/niche) are excluded from tag matching", () => {
    const row = {
      conf: {
        key: "jip",
        title: "JIP",
        full_name: "Journal of Information Processing",
        tags: ["journal", "niche", "domestic-jp"],
      },
      cats: [],
    };
    // 本文に "journal" が含まれても汎用タグでは加点されない
    const b = R.breakdown(
      row,
      R.parsePaperLines("A survey of the journal publication process | survey, journal"),
    );
    expect(b.agg.tags).toBe(0);
  });

  it("topical tags still match after generic exclusion", () => {
    const row = {
      conf: {
        key: "icml",
        title: "ICML",
        full_name: "International Conference on Machine Learning",
        tags: ["machine-learning"],
      },
      cats: [],
    };
    const b = R.breakdown(
      row,
      R.parsePaperLines("Transformer scaling laws | machine learning, scaling"),
    );
    expect(b.agg.tags).toBe(10);
  });

  it("setSigWeights can override (benchmark sweep hook)", () => {
    R.setSigWeights({ jp: 15 });
    try {
      const b = R.breakdown(
        jpRow,
        R.parsePaperLines("モバイルエッジ向け分散処理ミドルウェア | 分散処理, モバイル, エッジ"),
      );
      expect(b.agg.jp).toBe(15);
    } finally {
      R.setSigWeights({ jp: 30 });
    }
    const back = R.breakdown(
      jpRow,
      R.parsePaperLines("モバイルエッジ向け分散処理ミドルウェア | 分散処理, モバイル, エッジ"),
    );
    expect(back.agg.jp).toBe(30);
  });
});

describe("representative-paper vocabulary (R12: 実論文で会議を拾う)", () => {
  const row = (papers: string[]) => ({
    conf: {
      key: "icml",
      title: "ICML",
      full_name: "International Conference on Machine Learning",
      tags: [],
      papers,
    },
    cats: [],
  });

  it("English query matches representative-paper vocabulary (bandits -> ICML)", () => {
    const b = R.breakdown(
      row(["Thresholded Lasso Bandit"]),
      R.parsePaperLines("Batched Dueling Bandits | bandits"),
    );
    expect(b.agg.name).toBeGreaterThan(0); // 会議名語彙でなくても papers 語彙で加点
  });

  it("duplicate paper words count once (8 titles with memory -> not 8x)", () => {
    const many = ["A memory system", "B memory allocator", "C memory pool"];
    const b = R.breakdown(row(many), R.parsePaperLines("Memory management | memory"));
    // memory は 3 回現れるが重複排除はしない（IDF で減衰する設計）。
    // ここでは「語彙一致が機能している」ことだけを検証
    expect(b.agg.name).toBeGreaterThanOrEqual(15);
  });

  it("Japanese query does NOT use English representative-paper vocabulary", () => {
    // 日本語タイトルに英語キーワード（bandits）が混ざる実ケース: papers 語彙に bandits が
    // あっても日本語クエリでは一致させない（s-p が icml に奪われる誤爆の再現防止）
    const b = R.breakdown(
      {
        conf: {
          key: "icml",
          title: "ICML",
          full_name: "International Conference on Machine Learning",
          tags: [],
          papers: ["Thresholded Lasso Bandit"],
        },
        cats: [],
      },
      R.parsePaperLines("帯域付きバンディットの効率的学習 | バンディット, 機械学習, bandits"),
    );
    expect(b.agg.name).toBe(0);
  });
});

describe("buildNameIdf (R14: 会議名/代表論文語彙の 2 マップ IDF)", () => {
  it("name map: rare words weigh more than generic words", () => {
    const confs = [
      {
        key: "a",
        title: "A",
        full_name: "Conference on Bandit Learning",
        papers: ["Optimization"],
      },
      {
        key: "b",
        title: "B",
        full_name: "Workshop on Machine Learning",
        papers: ["Bandits and Optimization"],
      },
      {
        key: "c",
        title: "C",
        full_name: "Symposium on Storage Systems",
        papers: ["Distributed Bandits"],
      },
    ];
    const m = R.buildNameIdf(confs);
    // name 側: 希少語（bandit/storage/machine は df=1）> 汎用語（learning は df=2）
    expect(m.name.learning).toBeLessThan(m.name.bandit);
    expect(m.name.bandit).toBe(m.name.storage);
    // papers 側: 希少語（distributed df=1）> 汎用語（bandits/optimization df=2）
    expect(m.paper.bandits).toBeLessThan(m.paper.distributed);
    // machine は名前にしか出ない → paper マップには無い
    expect(m.paper.machine).toBeUndefined();
  });

  it("setNameIdf consumes {name, paper} maps (score scales with rarity)", () => {
    R.setNameIdf({ name: { bandits: 1.0, machine: 0.1 }, paper: { bandits: 1.0, machine: 0.1 } });
    try {
      const b = R.breakdown(
        {
          conf: {
            key: "icml",
            title: "ICML",
            full_name: "Machine Learning Conference",
            tags: [],
            papers: ["Bandits and Optimization"],
          },
          cats: [],
        },
        R.parsePaperLines("Bandits | bandits, machine"),
      );
      // name: machine 15×0.1=2、paper: bandits 15×1.0=15 → 合計 17
      expect(b.agg.name).toBe(17);
    } finally {
      R.setNameIdf(null);
    }
  });

  it("paperCap caps representative-paper hits per line (R14: rtss 汎用語の 100% 支配対策)", () => {
    R.setSigWeights({ paperCap: 2 });
    try {
      const conf = {
        key: "rtss",
        title: "RTSS",
        full_name: "The IEEE Real-Time Systems Symposium",
        tags: [],
        papers: [
          "Real-Time Vision Model Serving",
          "Memory Analysis for Multicore Systems",
          "Resource Control in Distributed Networks",
        ],
      };
      // クエリは papers 語に 3 語一致するが paperCap=2 で 2 語ぶんだけ加点される
      const b = R.breakdown(
        { conf, cats: [] },
        R.parsePaperLines("vision memory resource | vision, memory, resource"),
      );
      const uncapped = R.breakdown(
        { conf, cats: [] },
        R.parsePaperLines("vision memory resource | vision, memory, resource"),
      );
      // paperCap なし（999）との差分 = 3 語目（約 paper 重み 15）が落ちる
      R.setSigWeights({ paperCap: 999 });
      const full = R.breakdown(
        { conf, cats: [] },
        R.parsePaperLines("vision memory resource | vision, memory, resource"),
      );
      expect(b.agg.name).toBe(uncapped.agg.name);
      expect(full.agg.name).toBeGreaterThan(b.agg.name);
    } finally {
      R.setSigWeights({ paperCap: 4 });
    }
  });
});

describe("pickRepresentative", () => {
  it("prefers future deadline over past", () => {
    // 同一会議に過去締切と未来締切があるとき未来を代表にする
    const picked = R.pickRepresentative(
      [
        {
          conf: { key: "rtss" },
          kind: "paper",
          t: Date.parse("2026-05-22T23:59:59Z"),
          tLast: Date.parse("2026-05-22T23:59:59Z"),
        },
        {
          conf: { key: "rtss" },
          kind: "paper",
          t: Date.parse("2027-05-20T23:59:59Z"),
          tLast: Date.parse("2027-05-20T23:59:59Z"),
        },
      ],
      NOW,
    );
    expect(picked.map((p: any) => p.t)).toEqual([Date.parse("2027-05-20T23:59:59Z")]);
  });

  it("prefers deadline over event", () => {
    const picked = R.pickRepresentative(
      [
        {
          conf: { key: "foo" },
          kind: "event",
          t: Date.parse("2026-08-15T00:00:00Z"),
          tLast: Date.parse("2026-08-17T00:00:00Z"),
        },
        {
          conf: { key: "foo" },
          kind: "paper",
          t: Date.parse("2026-09-01T23:59:59Z"),
          tLast: Date.parse("2026-09-01T23:59:59Z"),
        },
      ],
      NOW,
    );
    expect(picked.map((p: any) => p.kind)).toEqual(["paper"]);
  });

  it("keeps distinct venues", () => {
    const picked = R.pickRepresentative(
      [
        { conf: { key: "a" }, kind: "paper", t: NOW + 1 },
        { conf: { key: "b" }, kind: "paper", t: NOW + 2 },
      ],
      NOW,
    );
    expect(picked.map((p: any) => p.conf.key).sort()).toEqual(["a", "b"]);
  });
});

describe("rankMatches", () => {
  it("matches the exact grade across schemes", () => {
    expect(R.rankMatches(["ccf:A", "core:A*", "thcpl:A"], "A")).toBe(true);
    expect(R.rankMatches(["ccf:B", "core:A*"], "B")).toBe(true);
    expect(R.rankMatches(["core:A*"], "A*")).toBe(true);
    expect(R.rankMatches(["ccf:N"], "N")).toBe(true);
  });

  it("A* is not A (regression: substring indexOf matched core:A*)", () => {
    expect(R.rankMatches(["ccf:B", "core:A*"], "A")).toBe(false);
    expect(R.rankMatches(["ccf:N", "core:A*", "thcpl:N"], "A")).toBe(false);
  });

  it("no pairs never match", () => {
    expect(R.rankMatches([], "A")).toBe(false);
    expect(R.rankMatches(undefined, "A")).toBe(false);
  });
});

describe("journalRows", () => {
  it("creates rows only for always-open journals", () => {
    const confs = [
      {
        key: "j1",
        title: "Journal A",
        full_name: "Full Name of Journal A",
        tags: ["journal"],
        rank: { ccf: "A", core: "A*" },
        editions: [],
      },
      {
        key: "si",
        title: "Special Issue",
        tags: ["special-issue"],
        editions: [{ deadlines: [{ utc: "2026-09-01T00:00:00Z" }] }],
      },
      { key: "c1", title: "Conf A", tags: [], editions: [] },
    ];
    const rows = R.journalRows(confs, NOW);
    expect(rows.map((r: any) => r.conf.key)).toEqual(["j1"]);
    expect(rows[0].kind).toBe("journal");
    expect(rows[0].t).toBe(NOW);
    expect(rows[0].dl.label).toBe("");
    expect(rows[0].rankPairs).toEqual(["ccf:A", "core:A*"]);
    expect(rows[0].hay).toContain("journal a");
    expect(rows[0].hay).toContain("full name of journal a");
    expect(rows[0].hay).toContain("j1");
    expect(rows[0].hay).toContain("常時受付");
  });

  it("hay supports keyword search without throwing", () => {
    const confs = [
      {
        key: "tocs",
        title: "TOCS",
        full_name: "ACM Transactions on Computer Systems",
        tags: ["journal"],
        rank: { ccf: "A" },
        editions: [],
      },
    ];
    const rows = R.journalRows(confs, NOW);
    expect(rows[0].hay.indexOf("tocs") >= 0).toBe(true);
    expect(rows[0].hay.indexOf("transactions") >= 0).toBe(true);
    expect(rows[0].hay.indexOf("nonexistent") >= 0).toBe(false);
    expect(R.rankMatches(rows[0].rankPairs, "A")).toBe(true);
    expect(R.rankMatches(rows[0].rankPairs, "A*")).toBe(false);
  });

  it("journal with deadlines stays a deadline row", () => {
    const confs = [
      {
        key: "j2",
        title: "Journal B",
        tags: ["journal"],
        editions: [{ deadlines: [{ utc: "2026-12-01T00:00:00Z" }] }],
      },
    ];
    expect(R.journalRows(confs, NOW)).toEqual([]);
  });
});

describe("pastRepresentatives", () => {
  it("only venues without a future deadline get one past rep", () => {
    const rows = [
      { conf: { key: "a" }, kind: "paper", t: NOW - 1000, est: false },
      { conf: { key: "a" }, kind: "paper", t: NOW - 2000, est: false },
      { conf: { key: "b" }, kind: "paper", t: NOW - 1000, est: false },
      { conf: { key: "b" }, kind: "paper", t: NOW + 1000, est: false },
      { conf: { key: "c" }, kind: "event", t: NOW - 1000, est: false },
      { conf: { key: "d" }, kind: "paper", t: NOW - 1000, est: true },
    ];
    const reps = R.pastRepresentatives(rows, NOW);
    expect(reps.map((r: any) => r.conf.key)).toEqual(["a"]);
    expect(reps[0].t).toBe(NOW - 1000); // 直近の過去 1 行のみ
  });
});

describe("comparePapers", () => {
  it("future first on tie, score first overall", () => {
    const past = {
      _matchScore: 50,
      kind: "paper",
      t: Date.parse("2026-06-01T00:00:00Z"),
      tLast: Date.parse("2026-06-01T00:00:00Z"),
    };
    const future = {
      _matchScore: 50,
      kind: "paper",
      t: Date.parse("2026-12-01T00:00:00Z"),
      tLast: Date.parse("2026-12-01T00:00:00Z"),
    };
    const higher = {
      _matchScore: 60,
      kind: "paper",
      t: Date.parse("2026-06-01T00:00:00Z"),
      tLast: Date.parse("2026-06-01T00:00:00Z"),
    };
    expect(R.comparePapers(past, future, NOW) > 0).toBe(true); // future が先
    expect(R.comparePapers(future, past, NOW) < 0).toBe(true);
    expect(R.comparePapers(higher, future, NOW) < 0).toBe(true); // スコア優先
  });
});

describe("venueCategories", () => {
  it("derives categories from a tag", () => {
    // RTSS タグ → systems カテゴリが推定される
    const lines = R.parsePaperLines("Paper A | kw | RTSS");
    const rows = [
      {
        conf: { key: "rtss", title: "RTSS", full_name: "IEEE Real-Time Systems Symposium" },
        cats: ["systems"],
      },
      {
        conf: { key: "sigcomm", title: "SIGCOMM", full_name: "ACM SIGCOMM" },
        cats: ["networking"],
      },
    ];
    expect(R.venueCategories(lines, rows).sort()).toEqual(["systems"]);
  });

  it("empty without a tag", () => {
    const lines = R.parsePaperLines("Paper A | kw");
    const rows = [
      {
        conf: { key: "rtss", title: "RTSS", full_name: "IEEE Real-Time Systems Symposium" },
        cats: ["systems"],
      },
    ];
    expect(R.venueCategories(lines, rows)).toEqual([]);
  });
});

// ---- セマンティック（埋め込み） ----

describe("semantic functions", () => {
  it("cosine identical and orthogonal", () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    const c = [2, 0, 0];
    expect(R.cosine(a, c)).toBe(1); // 同じ方向 → 1
    expect(R.cosine(a, b)).toBe(0); // 直交 → 0
    expect(R.cosine([], a)).toBe(0); // 空 → 0
    expect(R.cosine(null, a)).toBe(0); // null → 0
  });

  it("semantic score scaling", () => {
    // cosine 0.2 以下は 0、1.0 で 100 にスケーリングされる
    const emb = {
      same: [1, 0, 0],
      partial: [0.8, 0.6, 0],
      orth: [0, 1, 0],
    };
    const q = [1, 0, 0];
    expect(R.semanticScore("same", q, emb)).toBe(100); // cosine=1 → 100
    expect(R.semanticScore("orth", q, emb)).toBe(0); // cosine=0 → 0
    expect(R.semanticScore("missing", q, emb)).toBe(0); // キー無し → 0
    expect(R.semanticScore("same", null, emb)).toBe(0); // query 無し → 0
  });

  it("semanticScore は paperVecs の max 類似度を使う (R16)", () => {
    const emb = { v: [1, 0, 0] }; // 会議名ベクトル: query と直交
    const paperVecs = {
      v: [
        [0, 1, 0],
        [0, 0.8, 0.6],
      ],
    }; // 論文ベクトル: 2 本目が近い
    const q = [0, 0.8, 0.6];
    // 会議名のみ: cosine=0 → 0
    expect(R.semanticScore("v", q, emb)).toBe(0);
    // paperVecs あり: 2 本目の cosine=1 → 100（max が効く）
    expect(R.semanticScore("v", q, emb, paperVecs)).toBe(100);
    // 引数なしでも setPaperVecs の状態を使う
    R.setPaperVecs(paperVecs);
    expect(R.semanticScore("v", q, emb)).toBe(100);
    R.setPaperVecs(null);
    expect(R.semanticScore("v", q, emb)).toBe(0); // クリア後は従来動作
  });

  it("matchVenueTag finds the tagged venue (PRF 用)", () => {
    const confs = [
      { key: "rtss", title: "RTSS", full_name: "The IEEE Real-Time Systems Symposium", tags: [] },
      { key: "s-p", title: "S&P", full_name: "IEEE Symposium on Security and Privacy", tags: [] },
      {
        key: "sc",
        title: "SC",
        full_name: "International Conference for High Performance Computing",
        tags: [],
      },
      {
        key: "sigmod",
        title: "SIGMOD",
        full_name: "ACM SIGMOD International Conference on Management of Data",
        tags: [],
      },
    ];
    const keys = (v: string): string[] =>
      R.matchVenueTag(v, confs).map((c: { key: string }) => c.key);
    expect(keys("IEEE RTSS")).toEqual(["rtss"]); // 名称部分一致
    expect(keys("RTSS")).toEqual(["rtss"]); // key 一致
    expect(keys("Real-Time Systems")).toEqual(["rtss"]); // full_name 部分一致
    expect(keys("SP")).toEqual(["s-p"]); // 2 文字 + エイリアス
    expect(keys("SC")).toEqual(["sc"]); // 2 文字は key 完全一致のみ
    expect(R.matchVenueTag("NoSuchVenue", confs)).toEqual([]);
    expect(R.matchVenueTag("x", confs)).toEqual([]); // 短すぎ
  });

  it("matchVenueTag handles Japanese tags and short-tag false positives", () => {
    const confs = [
      {
        key: "ipsj-sigdps",
        title: "情報処理学会 DPS 研究会",
        full_name: "情報処理学会 マルチメディア通信と分散処理研究会 (SIGDPS)",
        tags: [],
      },
      {
        key: "ipdps",
        title: "IPDPS",
        full_name: "IEEE International Parallel and Distributed Processing Symposium",
        tags: [],
      },
      { key: "isc", title: "ISC", full_name: "Information Security Conference", tags: [] },
      {
        key: "isca",
        title: "ISCA",
        full_name: "International Symposium on Computer Architecture",
        tags: [],
      },
    ];
    const keys = (v: string): string[] =>
      R.matchVenueTag(v, confs).map((c: { key: string }) => c.key);
    // 日本語タグ: 原文照合で DPS 研究会に一致し、IPDPS（"ipdps" に "dps" を含む）には誤爆しない
    expect(keys("情報処理学会 DPS 研究会")).toEqual(["ipsj-sigdps"]);
    // 短い正規化タグは完全一致のみ（"isc" が "isca" に部分一致しない）
    expect(keys("ISC")).toEqual(["isc"]);
  });

  it("venueHit: Japanese tag boosts only the matching venue", () => {
    const r = {
      conf: {
        key: "ipsj-sigdps",
        title: "情報処理学会 DPS 研究会",
        full_name: "情報処理学会 マルチメディア通信と分散処理研究会 (SIGDPS)",
        tags: [],
      },
      cats: ["systems"],
    };
    const line = {
      title: "分散システムにおける複製管理",
      keywords: "分散処理, レプリケーション",
      venue: "情報処理学会 DPS 研究会",
    };
    expect(R.breakdown(r, [line]).venueHit).toBe(true);
    // IPDPS 側では同じタグで venueHit が立たない
    const ipdps = {
      conf: {
        key: "ipdps",
        title: "IPDPS",
        full_name: "IEEE International Parallel and Distributed Processing Symposium",
        tags: [],
      },
      cats: ["hpc"],
    };
    expect(R.breakdown(ipdps, [line]).venueHit).toBe(false);
  });

  it("blendVectors mixes paper + venue and normalizes", () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    const out: number[] = R.blendVectors(a, b, 0.7);
    expect(out.length).toBe(3);
    const norm = Math.sqrt(out.reduce((s: number, x: number) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 5); // L2 正規化
    expect(R.cosine(out, a)).toBeGreaterThan(R.cosine(out, b)); // 論文寄り
    expect(R.blendVectors(a, b, 1)).toEqual([1, 0, 0]); // w=1 → 論文のみ
    expect(R.blendVectors(a, null)).toEqual(a); // b 無し → そのまま
    expect(R.blendVectors([1], [1, 2])).toEqual([1]); // 長さ不一致 → そのまま
  });

  it("query text emphasizes the primary (first) line", () => {
    // 先頭行（自分の投稿予定論文）は 2 回含めて強調し、参考論文のノイズに埋没させない
    const lines = R.parsePaperLines("Paper A | kw1, kw2 | RTSS\nPaper B | kw3");
    expect(R.queryText(lines)).toBe("Paper A kw1, kw2 Paper A kw1, kw2 Paper B kw3");
  });

  it("query text single line repeats once (no semantic change)", () => {
    const lines = R.parsePaperLines("Paper A | kw1");
    expect(R.queryText(lines)).toBe("Paper A kw1 Paper A kw1");
  });
});

describe("blendScore", () => {
  it("mid/long English queries blend at 0.4/0.6", () => {
    expect(R.blendScore(40, 60)).toBe(52); // 既定 len=undefined → 0.4: round(40×0.4+60×0.6) = 52
    expect(R.blendScore(40, 60, { len: 8 })).toBe(52);
    expect(R.blendScore(40, 60, { len: 5 })).toBe(52);
  });

  it("short English queries blend semantic-heavy at 0.25/0.75", () => {
    expect(R.blendScore(40, 60, { len: 2 })).toBe(55); // round(40×0.25+60×0.75) = 55
    expect(R.blendScore(0, 80, { len: 3 })).toBe(60);
  });

  it("falls back to vocab score when semantic is unavailable", () => {
    expect(R.blendScore(40, 0)).toBe(40);
    expect(R.blendScore(40, null)).toBe(40);
    expect(R.blendScore(52, undefined)).toBe(52);
  });

  it("0.6/0.4 blend for Japanese papers (vocab is the stronger signal)", () => {
    expect(R.blendScore(40, 60, { jp: true })).toBe(48); // round(40×0.6+60×0.4) = 48
    expect(R.blendScore(0, 80, { jp: true })).toBe(32);
    expect(R.blendScore(50, 50, { jp: true })).toBe(50);
  });

  it("explicit jpw override wins (benchmark sweep support)", () => {
    expect(R.blendScore(40, 60, { jp: true, jpw: 0.7 })).toBe(46); // round(40×0.7+60×0.3) = 46
    expect(R.blendScore(40, 60, { jpw: 0.3 })).toBe(54);
  });
});

describe("contentWordCount", () => {
  it("counts distinct content words, ignoring stopwords and short words", () => {
    expect(
      R.contentWordCount(
        "Time-Sensitive Networking Scheduling for Deterministic Industrial Networks",
      ),
    ).toBe(5);
    expect(R.contentWordCount("the a and of for")).toBe(0);
    expect(R.contentWordCount("")).toBe(0);
    expect(R.contentWordCount(null)).toBe(0);
  });

  it("does not count Japanese (english-only counter)", () => {
    expect(R.contentWordCount("分散システムにおける低遅延ミドルウェア")).toBe(0);
  });
});

describe("expandJp (表示用の日本語→英語展開)", () => {
  it("expands Japanese domain words to English", () => {
    const out = R.expandJp("低遅延リアルタイムシステム");
    expect(out).toContain("latency");
    expect(out).toContain("real-time");
  });

  it("returns empty for English or empty text", () => {
    expect(R.expandJp("Kubernetes with eBPF")).toBe("");
    expect(R.expandJp("")).toBe("");
  });

  it("can be disabled (benchmark A/B hook)", () => {
    R.setExpandEnabled(false);
    expect(R.expandJp("低遅延")).toBe("");
    R.setExpandEnabled(true);
    expect(R.expandJp("低遅延")).toContain("latency");
  });
});

describe("hasJapanese", () => {
  it("detects hiragana/katakana/kanji", () => {
    expect(R.hasJapanese("分散システムにおける低遅延ミドルウェア")).toBe(true);
    expect(R.hasJapanese("コンピュータ ネットワーク")).toBe(true);
    expect(R.hasJapanese("Kubernetes Service Mesh with eBPF")).toBe(false);
    expect(R.hasJapanese("")).toBe(false);
    expect(R.hasJapanese(null)).toBe(false);
  });
});

describe("venue normalization robustness", () => {
  const rows = [
    {
      conf: {
        key: "s-p",
        title: "S&P",
        full_name: "IEEE Symposium on Security and Privacy",
      },
      cats: ["security"],
    },
    {
      conf: {
        key: "sigcomm",
        title: "SIGCOMM",
        full_name: "ACM Special Interest Group on Data Communication",
      },
      cats: ["networking"],
    },
  ];
  const hit = (paper: string, key: string): boolean => {
    const row = rows.find((r) => r.conf.key === key)!;
    return R.breakdown(row, R.parsePaperLines(paper)).venueHit;
  };

  it("SP short alias matches IEEE S&P", () => {
    expect(hit("Paper on side channels | security | SP", "s-p")).toBe(true);
  });

  it("& vs and spelling variant matches", () => {
    expect(
      hit("Paper on side channels | security | IEEE Symposium on Security & Privacy", "s-p"),
    ).toBe(true);
  });

  it("proceedings-style venue string with filler words matches", () => {
    expect(
      hit(
        "Paper on side channels | security | Proceedings of the IEEE Symposium on Security and Privacy",
        "s-p",
      ),
    ).toBe(true);
  });

  it("S&P spelling does not leak to other conferences", () => {
    expect(hit("Paper on side channels | security | SP", "sigcomm")).toBe(false);
  });
});

// ---- 実データ統合テスト（public/data.json があるときのみ） ----

describe.skipIf(!hasData)("real data integration", () => {
  const makeScript = (papers: string, topN = 10): { cats: string[]; top: any[]; n: number } => {
    const rows = loadRows();
    const lines = R.parsePaperLines(papers);
    const cats = R.autoDetectCats(lines);
    const scored = rows
      .map((r) => ({
        key: r.conf.key,
        score: R.scorePapers(r, lines),
        hit: R.breakdown(r, lines).venueHit,
      }))
      .filter((x) => x.score >= 10)
      .sort((a, b) => b.score - a.score);
    return { cats, top: scored.slice(0, topN), n: scored.length };
  };

  it("venuePapersHash は決定的で内容変化を反映する（R29）", () => {
    const h1 = venuePapersHash();
    const h2 = venuePapersHash();
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{16}$/);
  });

  it("embeddings.json covers all conferences", () => {
    try {
      const emb = JSON.parse(readFileSync(EMB_JSON, "utf8"));
      const data = JSON.parse(readFileSync(DATA_JSON, "utf8"));
      const keys = new Set<string>(data.conferences.map((c: any) => c.key));
      const embKeys = new Set(Object.keys(emb.embeddings ?? {}));
      expect([...keys].every((k) => embKeys.has(k))).toBe(true);
      const dims = new Set(Object.values(emb.embeddings).map((v: any) => v.length));
      expect(dims).toEqual(new Set([emb.dim]));
    } catch {
      // embeddings.json 未生成（transformers.js 依存のため）はスキップ
    }
  });

  it("TSN paper finds real-time venues", () => {
    const { cats, top } = makeScript(
      "投稿予定: Credit-Based Shaping for Deterministic Latency in Time-Sensitive Networking | " +
        "TSN, CBS, latency, scheduling, Ethernet, real-time\n" +
        "似た論文: Design and Analysis of Credit-Based Shapers in TSN | TSN, CBS, QoS | RTSS\n" +
        "似た論文: Low-Latency Scheduling for Time-Sensitive Networks | scheduling, latency | IWQoS",
      8,
    );
    expect(cats).toContain("networking");
    const keys = top.map((t) => t.key);
    expect(keys.some((k) => k.includes("rtss"))).toBe(true); // RTSS（掲載先タグ）が top 圏内
    expect(top.some((t) => t.hit)).toBe(true);
  });

  it("storage paper lands systems", () => {
    const { cats, top } = makeScript(
      "A Scalable Log-Structured Storage Engine for Multitenant Cloud Servers | " +
        "storage, log-structured, cloud, multitenant, scalability\n" +
        "The Design of a Log-Structured File System | log-structured, filesystem, storage | FAST",
      8,
    );
    expect(cats).toContain("systems");
    const keys = top.map((t) => t.key);
    expect(keys.some((k) => k.includes("fast"))).toBe(true);
  });

  it("no papers no match", () => {
    const { cats, top, n } = makeScript("", 5);
    expect(cats).toEqual([]);
    expect(top).toEqual([]);
    expect(n).toBe(0);
  });

  it("security paper lands top tier", () => {
    const { cats, top } = makeScript(
      "Post-Quantum Key Exchange for Encrypted Network Traffic | security, crypto, encryption, privacy, attack\n" +
        "SoK: Hardware-Enforced Memory Isolation | security, enclave, sgx, memory | IEEE Symposium on Security & Privacy",
      10,
    );
    expect(cats).toContain("security");
    const keys = top.map((t) => t.key).join(" ");
    // IEEE S&P / USENIX Security / CCS のいずれかが上位に来る（タグ投票で S&P が必ず入る）
    expect(
      ["ieee-symposium-on-security", "usenix-security", "ccs"].some((x) => keys.includes(x)),
    ).toBe(true);
  });

  it("ML paper lands NeurIPS/ICML", () => {
    const { cats, top } = makeScript(
      "Scaling Laws for Transformer Language Models | transformer, llm, deep learning, neural, machine learning\n" +
        "Diffusion Models for Generative Image Synthesis | diffusion, generative, image | NeurIPS",
      10,
    );
    expect(cats).toContain("ai");
    const keys = top.map((t) => t.key);
    expect(keys.some((k) => k.includes("neurips"))).toBe(true);
  });

  it("venue tag beats generic category noise", () => {
    // タグ付き掲載先（RTSS）は、カテゴリ一致だけの無関係会議（ASAP 等）より明確に上位
    const { top } = makeScript(
      "投稿予定: Credit-Based Shaping for Deterministic Latency in TSN | TSN, CBS, latency, scheduling, Ethernet, real-time\n" +
        "似た論文: Design and Analysis of Credit-Based Shapers in TSN | TSN, CBS, QoS | RTSS",
      12,
    );
    const scores = Object.fromEntries(top.map((t) => [t.key, t.score]));
    expect(scores.rtss ?? 0).toBeGreaterThan(scores.asap ?? 0);
    expect(scores.rtss ?? 0).toBeGreaterThan(scores.ase ?? 0);
    const rtss = top.find((t) => t.key === "rtss");
    expect(rtss?.hit).toBe(true);
  });

  it("short venue tag SC matches by key", () => {
    // 2 文字タグ（SC）は key 完全一致で掲載先として効く
    const { top } = makeScript(
      "Scheduling Large-Scale MPI Jobs on Heterogeneous Supercomputers | HPC, MPI, scheduling, cluster, GPU\n" +
        "Supercomputing Interconnect for Exascale Systems | interconnect, HPC, network | SC",
      12,
    );
    const sc = top.find((t) => t.key === "sc");
    expect(sc).toBeTruthy();
    expect(sc.hit).toBe(true);
    const cluster = top.find((t) => t.key === "cluster");
    if (cluster) expect(sc.score).toBeGreaterThan(cluster.score);
  });

  it("Japanese paper finds Japanese venues", () => {
    const { top } = makeScript(
      "分散システムにおける低遅延ミドルウェア | 分散, ミドルウェア, 低遅延, システム",
      12,
    );
    const scores = Object.fromEntries(top.map((t) => [t.key, t.score]));
    const jpHits = top.filter((t) => t.score >= 20).map((t) => t.key);
    expect(jpHits.length).toBeGreaterThanOrEqual(1); // 日本語会議名（comsys/ipsj-sigarc 等）が拾われる
    expect(Math.max(...jpHits.map((k) => scores[k] ?? 0))).toBeGreaterThan(scores.asap ?? 0);
  });

  it("paper mode pipeline: dedupes, past reps and journals included", () => {
    // 論文モード: 未来締切 + 未来の無い会議の過去代表 + 常時受付ジャーナルを網羅し、
    // 会議単位に集約してスコア降順で並ぶ（網羅性を優先する設計）
    const data = JSON.parse(readFileSync(DATA_JSON, "utf8"));
    const _DAY = 86400000;
    const rows: any[] = [];
    for (const c of data.conferences) {
      for (const ed of c.editions ?? []) {
        for (const dl of ed.deadlines ?? []) {
          rows.push({
            conf: c,
            ed,
            cats: c.categories ?? [],
            key: c.key,
            kind: dl.kind ?? "deadline",
            t: Date.parse(dl.utc),
            tLast: Date.parse(dl.utc),
            est: !!(dl.estimated || ed.estimated),
            rankPairs: [],
            name: c.title,
            year: ed.year,
          });
        }
      }
    }
    const pLines = R.parsePaperLines(
      "Credit-Based Shaping for Deterministic Latency in TSN | TSN, CBS, latency, real-time\n" +
        "Similar Paper on TSN Scheduling | scheduling, TSN | RTSS",
    );
    const venueCats = R.venueCategories(pLines, rows);
    const pool = rows.concat(
      R.journalRows(data.conferences, NOW),
      R.pastRepresentatives(rows, NOW),
    );
    let out = pool
      .filter((r) => r.kind === "abstract" || r.kind === "paper" || r.kind === "journal")
      .filter((r) => !(r.est && r.t < NOW))
      .map((r) => {
        const m = R.breakdown(r, pLines);
        let score = m.score;
        if (!m.venueHit && venueCats.length) {
          const shared = (r.cats ?? []).some((k: string) => venueCats.includes(k));
          if (shared) score = Math.min(100, score + 10);
        }
        r._matchScore = score;
        return r;
      })
      .filter((r) => r._matchScore >= 10);
    out.sort((a, b) => R.comparePapers(a, b, NOW));
    out = R.pickRepresentative(out, NOW);

    const keys = out.map((r) => r.conf.key);
    const unique = new Set(keys).size === keys.length;
    const sorted = out.every((r, i) => i === 0 || out[i - 1]._matchScore >= r._matchScore);
    const rtasIdx = keys.indexOf("rtas");
    const rtssIdx = keys.indexOf("rtss");
    const hasJournal = out.some((r) => r.kind === "journal");

    expect(unique).toBe(true); // 会議単位に集約
    expect(sorted).toBe(true); // スコア降順
    expect(rtasIdx >= 0 && rtasIdx < 3).toBe(true); // RTAS が上位
    expect(rtssIdx).toBe(0); // 掲載先タグ付き過去行 (RTSS) が最上位
    expect(hasJournal).toBe(true); // 常時受付ジャーナルが含まれる
  });
});

describe("GOLDEN_EN と VENUE_PAPERS のリークなし設計 (R12–R17)", () => {
  it("golden テストセットのタイトルは強化用 VENUE_PAPERS と重複しない", () => {
    // bench の GOLDEN_EN（実採択論文）と embeddings の VENUE_PAPERS（会議プロファイル強化）は
    // 完全分離が契約（テストに正解を学習させない）。タイトルを正規化して照合する。
    const norm = (s: string): string =>
      String(s ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
    const benchSrc = readFileSync(join(REPO_ROOT, "src", "bench-recommender.ts"), "utf8");
    const embSrc = readFileSync(join(REPO_ROOT, "src", "embeddings.ts"), "utf8");
    // 保守性のため正規表現で抽出（構造変化時はここを更新）
    const goldenTitles = [...benchSrc.matchAll(/title: "([^"]+)",\s*key: "([a-z-]+)"/g)].map((m) =>
      norm(m[1]),
    );
    const paperTitles = [...embSrc.matchAll(/"([^"]+)",?\s*\n/g)].map((m) => norm(m[1]));
    expect(goldenTitles.length).toBeGreaterThan(50); // GOLDEN_EN が実在する
    const overlap = goldenTitles.filter((t) => t.length > 10 && paperTitles.includes(t));
    expect(overlap).toEqual([]); // 完全分離
  });

  it("GENERIC_PAPER_WORDS: papers 語彙の汎用語（self/general/framework 等）は加点されない (R18)", () => {
    // R18 実測: rtss の papers 語彙（self/general/framework/vision/language）が data2vec
    // クエリに 5 ヒットして 49 点を稼ぎ、sem が効く icml を blendScore の減衰で下回って
    // top1 を奪った。self/general/framework は論文タイトルに頻出するが会議の識別に
    // 寄与しない汎用語 — papers 語彙マッチから除外する（名前語マッチには影響しない）。
    R.setNameIdf(null);
    try {
      const b = R.breakdown(
        {
          conf: {
            key: "t-conf",
            title: "Test Conference",
            full_name: "",
            tags: [],
            papers: ["A General Framework for Self-Supervised Vision Learning"],
          },
          cats: [],
        },
        R.parsePaperLines(
          "data2vec: A General Framework for Self-supervised Learning in Speech, Vision and Language",
        ),
      );
      // GENERIC 除外後: paper 語彙で残るのは supervised + vision（+30）。
      // self/general/framework/learning は除外（supervised は self-supervised の専門語として残す）。
      expect(b.agg.name).toBe(30);
    } finally {
      R.setNameIdf(null);
    }
  });

  it("wordInText: 略語 trans は Transcompiling に部分マッチしない (R19 QiMeng→ieice 回帰)", () => {
    R.setNameIdf(null);
    try {
      // ieice の略語 trans/syst が QiMeng の Transcompiling/Systems に部分一致して
      // 46 点を稼いだ（R18 発見のバグ）。語境界一致で 0 になるはず。
      const b = R.breakdown(
        {
          conf: {
            key: "ieice-special",
            title: "IEICE Trans. Inf. & Syst. 特集号",
            full_name:
              "Special Section on Log Data Usage Technology and Office Information Systems",
            tags: [],
            papers: [],
          },
          cats: [],
        },
        R.parsePaperLines(
          "QiMeng-Xpiler: Transcompiling Tensor Programs for Deep Learning Systems with a Neural-Symbolic Approach",
        ),
      );
      expect(b.agg.name).toBe(0);
    } finally {
      R.setNameIdf(null);
    }
  });

  it("wordInText: 単複形（bandit→bandits）はマッチを維持する (R19)", () => {
    R.setNameIdf(null);
    try {
      // 純粋な語境界だと bandit ⊂ Bandits が消え、Batched Dueling Bandits が icml を
      // 拾えなくなる（実測で top10 -7.2pt 回帰）。末尾 s は許容する。
      const b = R.breakdown(
        {
          conf: {
            key: "t-conf",
            title: "Test Conference",
            full_name: "",
            tags: [],
            papers: ["Thresholded Lasso Bandit"],
          },
          cats: [],
        },
        R.parsePaperLines("Batched Dueling Bandits"),
      );
      expect(b.agg.name).toBeGreaterThanOrEqual(15);
    } finally {
      R.setNameIdf(null);
    }
  });

  it("GENERIC_PAPER_WORDS は名前語マッチに影響しない (R18)", () => {
    R.setNameIdf(null);
    try {
      // "learning" は GENERIC_PAPER_WORDS にあるが、名前語としては識別力があるので加点される
      const b = R.breakdown(
        {
          conf: {
            key: "t-conf",
            title: "Test Conference",
            full_name: "International Conference on Machine Learning",
            tags: [],
            papers: [],
          },
          cats: [],
        },
        R.parsePaperLines("self-supervised learning for speech"),
      );
      expect(b.agg.name).toBeGreaterThanOrEqual(15);
    } finally {
      R.setNameIdf(null);
    }
  });

  it("paperVecs は skipEmb 会議にのみ付与される (R16/R20)", () => {
    const embSrc = readFileSync(join(REPO_ROOT, "src", "embeddings.ts"), "utf8");
    // R16: usenix-security のみ paperVecs。R20: rtss を再追加（Timely Classification 対策。
    // golden top5 68.6→70.0・top10 75.7→78.6 の net プラスを実測）。ecrts は vocab のみ維持。
    expect(embSrc).toMatch(/for \(const key of \["usenix-security", "rtss"\]\)/);
    // rtss/ecrts/usenix-security は埋め込みから除外（vocab + paperVecs）
    expect(embSrc).toMatch(/SKIP_EMB_KEYS\.has\(key\)/);
  });
});

describe("getGCalUrl", () => {
  it("generates correct all-day date range for events", () => {
    const r = {
      conf: {
        key: "sigcomm",
        title: "SIGCOMM",
        full_name: "ACM SIGCOMM Conference",
        link: "https://example.com/sigcomm",
      },
      ed: {
        place: "Denver, USA",
        link: "https://example.com/sigcomm26",
      },
      kind: "event",
      t: new Date(Date.UTC(2026, 7, 17)).getTime(),
      tLast: new Date(Date.UTC(2026, 7, 21)).getTime(),
    };
    const url = R.getGCalUrl(r);
    expect(url).toContain("action=TEMPLATE");
    expect(url).toContain("text=%5BSIGCOMM%5D%20%E9%96%8B%E5%82%AC");
    expect(url).toContain("dates=20260817/20260822");
    expect(url).toContain("location=Denver%2C%20USA");
    expect(url).toContain("CFP%20Link%3A%20https%3A%2F%2Fexample.com%2Fsigcomm26");
  });

  it("generates correct 30-min window ending at deadline for paper deadlines", () => {
    const deadlineUtc = new Date(Date.UTC(2026, 1, 7, 11, 59, 59));
    const r = {
      conf: {
        key: "sigcomm",
        title: "SIGCOMM",
        full_name: "ACM SIGCOMM Conference",
      },
      ed: {
        place: "Denver, USA",
        link: "https://example.com/sigcomm26",
      },
      kind: "paper",
      t: deadlineUtc.getTime(),
    };
    const url = R.getGCalUrl(r);
    expect(url).toContain("dates=20260207T112959Z/20260207T115959Z");
    expect(url).toContain("text=%5BSIGCOMM%5D%20%E8%AB%96%E6%96%87%E7%B7%A0%E5%88%87");
  });

  it("handles null, empty, and invalid records gracefully", () => {
    expect(R.getGCalUrl(null)).toBe("");
    expect(R.getGCalUrl(undefined)).toBe("");
    expect(R.getGCalUrl({})).toBe("");
    expect(R.getGCalUrl({ conf: { key: "sigcomm" }, t: NaN })).toBe("");
    expect(R.getGCalUrl({ conf: { key: "sigcomm" }, t: new Date("invalid") })).toBe("");
  });

  it("includes comments and falls back to conf title when full_name is empty", () => {
    const r = {
      conf: {
        key: "niche-conf",
        title: "NICHE-CONF",
        full_name: "",
        link: "https://example.com/niche",
      },
      ed: {
        place: "Tokyo, Japan",
        link: "https://example.com/niche26",
      },
      kind: "paper",
      comment: "Round 2 Submission",
      t: new Date(Date.UTC(2026, 5, 1, 12, 0, 0)).getTime(),
    };
    const url = R.getGCalUrl(r);
    expect(url).toContain("NICHE-CONF");
    expect(url).toContain("%E5%82%99%E8%80%83%3A%20Round%202%20Submission"); // 備考: Round 2 Submission
    expect(url).toContain("CFP%20Link%3A%20https%3A%2F%2Fexample.com%2Fniche26");
  });

  it("extracts comment from r.dl.comment and formats round info when round > 1", () => {
    const r = {
      conf: {
        key: "nsdi",
        title: "NSDI",
        full_name: "USENIX Symposium on Networked Systems Design and Implementation",
      },
      ed: {
        place: "Renton, WA, USA",
        link: "https://www.usenix.org/conference/nsdi26",
      },
      dl: {
        round: 2,
        comment: "Fall deadline",
      },
      kind: "paper",
      t: new Date(Date.UTC(2026, 8, 10, 23, 59, 59)).getTime(),
    };
    const url = R.getGCalUrl(r);
    expect(url).toContain("NSDI");
    expect(url).toContain("%20(R2)");
    expect(url).toContain("%E5%82%99%E8%80%83%3A%20Fall%20deadline"); // 備考: Fall deadline
    expect(url).toContain("%E3%83%A9%E3%82%A6%E3%83%B3%E3%83%89%3A%20Round%202"); // ラウンド: Round 2
  });
});

describe("bench-recommender argument parsing and helper utilities", () => {
  it("parseBenchArgs parses flags and equal-joined options", () => {
    const args = parseBenchArgs([
      "node",
      "bench-recommender.ts",
      "--data=public/custom_data.json",
      "--emb=public/custom_emb.json",
      "--samples=20",
      "--failures=3",
      "--topk=10",
      "--lang=jp",
      "--jpw=0.4",
      "--by-len",
      "--adaptive",
      "--penalty",
      "--prf",
      "--no-idf",
      "--golden-en",
      "--no-paper-max",
      "--sw=name=30,venue=70",
    ]);
    expect(args.data).toBe("public/custom_data.json");
    expect(args.emb).toBe("public/custom_emb.json");
    expect(args.samples).toBe(20);
    expect(args.failures).toBe(3);
    expect(args.topK).toBe(10);
    expect(args.lang).toBe("jp");
    expect(args.jpw).toBe(0.4);
    expect(args.wGiven).toBe(true);
    expect(args.byLen).toBe(true);
    expect(args.adaptive).toBe(true);
    expect(args.penalty).toBe(true);
    expect(args.prf).toBe(true);
    expect(args.idf).toBe(false);
    expect(args.goldenEn).toBe(true);
    expect(args.paperMax).toBe(false);
    expect(args.sw).toBe("name=30,venue=70");
  });

  it("parseBenchArgs parses short options", () => {
    const args = parseBenchArgs([
      "node",
      "bench-recommender.ts",
      "-d",
      "data.json",
      "-e",
      "emb.json",
      "-s",
      "50",
      "-f",
      "5",
      "-k",
      "3",
      "-l",
      "en",
      "--w",
      "0.6",
    ]);
    expect(args.data).toBe("data.json");
    expect(args.emb).toBe("emb.json");
    expect(args.samples).toBe(50);
    expect(args.failures).toBe(5);
    expect(args.topK).toBe(3);
    expect(args.lang).toBe("en");
    expect(args.jpw).toBe(0.6);
  });

  it("norm and contentWords handle null, undefined, empty, and stopwords", () => {
    expect(norm(null)).toBe("");
    expect(norm(undefined)).toBe("");
    expect(norm("  High-Performance Computing!  ")).toBe("high performance computing");

    expect(contentWords(null)).toEqual([]);
    expect(contentWords(undefined)).toEqual([]);
    expect(contentWords("the of and for distributed")).toEqual(["distributed"]);
  });

  it("topicWords filters generic tags and aggregates categories and titles", () => {
    expect(topicWords(null, {})).toEqual([]);
    expect(topicWords(undefined, {})).toEqual([]);

    const conf = {
      key: "sc",
      title: "SC",
      full_name:
        "International Conference for High Performance Computing, Networking, Storage and Analysis",
      categories: ["hpc", "networking"],
      tags: ["hpc", "supercomputing", "niche", "workshop"],
    };
    const catFull = {
      hpc: "High Performance Computing",
      networking: "Networking",
    };
    const words = topicWords(conf, catFull);
    expect(words).toContain("supercomputing");
    expect(words).toContain("performance");
    expect(words).not.toContain("niche");
    expect(words).not.toContain("workshop");
  });
});
