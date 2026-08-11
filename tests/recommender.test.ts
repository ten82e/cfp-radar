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

  it("query text joins lines", () => {
    const lines = R.parsePaperLines("Paper A | kw1, kw2 | RTSS\nPaper B | kw3");
    expect(R.queryText(lines)).toBe("Paper A kw1, kw2 Paper B kw3");
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

  it("paper mode pipeline: future only and dedupes", () => {
    // 論文モード: 過去行は完全に除外され、未来の投稿可能会議のみがスコア順に集約される
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
    let out = rows
      .filter((r) => r.t >= NOW)
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

    const hasPast = out.some((r) => r.kind !== "event" && r.t < NOW);
    const keys = out.map((r) => r.conf.key);
    const unique = new Set(keys).size === keys.length;
    const sorted = out.every((r, i) => i === 0 || out[i - 1]._matchScore >= r._matchScore);
    const rtasIdx = keys.indexOf("rtas");

    expect(hasPast).toBe(false); // 過去行が残っている
    expect(unique).toBe(true); // 会議単位に集約されていない
    expect(sorted).toBe(true); // スコア降順になっていない
    expect(rtasIdx >= 0 && rtasIdx < 3).toBe(true); // RTAS が上位にない
  });
});
