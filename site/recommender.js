/*
 * recommender.js — 論文タイトル/キーワード → 会議マッチングの純粋ロジック
 *
 * ブラウザ（template.html）と Node（テスト）の両方から使える。
 * 依存: なし（DOM 非依存）。
 *
 * 公開 API:
 *   parsePaperLines(text)      → [{title, keywords, venue}]  (1行1論文、| 区切り)
 *   autoDetectCats(lines)      → [catKey, ...]  分野自動判定（ヒット数の降順、0 件なら []）
 *   scorePapers(r, lines)      → number 0..100  (行平均。掲載先タグ一致はブースト)
 *   breakdown(r, lines)        → {score, venueHit, perLine: [...]}  デバッグ/表示用
 */
(function (root) {
  "use strict";

  /* 既存 template.html の DOMAIN_SIGNAL と同一（ここが正典）
   * 変更時は template.html 側の重複定義も同じ内容に保つこと。 */
  var DOMAIN_SIGNAL = {
    hpc: ["hpc", "supercomputing", "parallel", "gpu", "fpga", "cuda", "mpi", "interconnect", "cluster", "ハイパフォーマンス", "スーパーコンピュータ", "並列"],
    systems: ["storage", "nvme", "cxl", "rdma", "kernel", "operating system", "memory", "virtual", "compiler", "real-time", "realtime", "embedded", "deterministic", "tsn", "ストレージ", "カーネル", "分散システム", "ミドルウェア", "オペレーティングシステム"],
    networking: ["network", "sdn", "p4", "protocol", "wireless", "5g", "routing", "bpf", "ebpf", "packet", "ネットワーク", "通信", "ルーティング", "無線"],
    ai: ["machine learning", "deep learning", "neural", "sysml", "gnn", "transformer", "llm", "ai", "機械学習", "深層学習", "ニューラル", "生成"],
    security: ["security", "privacy", "crypto", "vulnerability", "binary", "enclave", "sgx", "confidential", "セキュリティ", "プライバシー", "暗号"],
    db: ["database", "query", "sql", "index", "data mining", "data management", "key-value", "oltp", "olap", "vector", "データベース", "クエリ", "データマイニング"],
    graphics: ["graphics", "rendering", "mesh", "animation", "multimedia", "video", "audio", "image processing", "computer vision", "3d", "ビジュアライゼーション", "可視化", "映像", "グラフィックス"],
    hci: ["human-computer", "user interface", "usability", "interaction", "accessibility", "touch", "augmented reality", "virtual reality", "ヒューマン", "ユーザインタフェース", "ユーザビリティ"],
    theory: ["algorithm", "complexity", "automata", "graph theory", "approximation", "lower bound", "combinatorial", "formal", "verification", "アルゴリズム", "計算量", "複雑性"]
  };

  var STOPWORDS = new Set(
    ("a an and or the of for in on to with via using based towards toward using design implementation " +
      "analysis study novel can we our this that from at by as is are be it its their these those paper papers " +
      "new towards between within across over under both each more most than then thus also such when while " +
      "which who what how why not no nor only into onto upon about above below out off they them he she his " +
      "her you your i me my mine do does did has have had will would could should may might must shall there " +
      "here been being was were am if else whether either neither yet still already just even though although " +
      "because system systems network networks conference symposium workshop international annual proceedings " +
      "ieee acm usenix journal letters transactions magazine association machinery electronics engineers " +
      "special interest group review about applications application computer computing science institute technical " +
      // 会議名によく出るが内容語としては弱い語（Signal Processing 等の誤爆防止）
      "processing technology advanced modern research recent emerging").split(/\s+/)
  );

  /* 1行: "タイトル | キーワード | 掲載先(任意)" または "タイトル<TAB>キーワード<TAB>掲載先" */
  function parsePaperLines(text) {
    if (!text) return [];
    return String(text)
      .split(/\r?\n/)
      .map(function (l) { return l.trim(); })
      .filter(Boolean)
      .map(function (l) {
        var parts = l.split(/\s*\|\s*/);
        if (parts.length === 1) parts = l.split(/\t+/);
        return {
          title: (parts[0] || "").trim(),
          keywords: (parts[1] || "").trim(),
          venue: (parts[2] || "").trim()
        };
      })
      .filter(function (p) { return p.title; });
  }

  function normKey(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  /* 会議側の照合文字列（key / title / full_name / tags / 日本語表記） */
  function confHay(r) {
    var c = r.conf || {};
    return {
      key: normKey(c.key),
      title: normKey(c.title),
      full: normKey(c.full_name),
      tags: (c.tags || []).map(normKey),
      jp: ((c.title || "") + " " + (c.full_name || "")).match(/[\u3000-\u9fff]+/g) || []
    };
  }

  /* 分野自動判定: 全論文テキストで各分野シグナルのヒット数を数える */
  function autoDetectCats(lines) {
    if (!lines || !lines.length) return [];
    var text = lines
      .map(function (p) { return p.title + " " + p.keywords; })
      .join(" ")
      .toLowerCase();
    var hits = [];
    Object.keys(DOMAIN_SIGNAL).forEach(function (dom) {
      var n = DOMAIN_SIGNAL[dom].filter(function (kw) { return text.indexOf(kw) !== -1; }).length;
      if (n > 0) hits.push({ dom: dom, n: n });
    });
    hits.sort(function (a, b) { return b.n - a.n; });
    return hits.map(function (h) { return h.dom; });
  }

  /* 1行ぶんのスコア (0..100)。venueHit は掲載先タグ一致なら true */
  function scoreLine(r, p, conf) {
    var pt = (p.title + " " + p.keywords).toLowerCase();
    if (!pt.trim()) return { score: 0, venueHit: false, details: { domain: 0, name: 0, jp: 0, tags: 0, venue: 0 } };
    var score = 0;
    var details = { domain: 0, name: 0, jp: 0, tags: 0, venue: 0 };

    // 分野シグナル: 論文にキーワードがあり、会議がそのカテゴリを持つ。
    // ヒット数ではなく「カテゴリにヒットしたか」で +15（累積しない）。
    Object.keys(DOMAIN_SIGNAL).forEach(function (dom) {
      if ((r.cats || []).indexOf(dom) === -1) return;
      var hit = DOMAIN_SIGNAL[dom].some(function (kw) { return pt.indexOf(kw) !== -1; });
      if (hit) { score += 15; details.domain += 15; }
    });

    // 会議名（title + full_name）の語彙一致（一般語は STOPWORDS で除外）
    var words = (conf.title + " " + conf.full).split(" ").filter(function (w) {
      return w.length > 3 && !STOPWORDS.has(w);
    });
    words.forEach(function (w) {
      if (pt.indexOf(w) !== -1) { score += 15; details.name += 15; }
    });

    // 日本語の部分一致: 論文の日本語チャンク（4 文字以上）が会議名の日本語に含まれれば加点
    // 例: 論文に「分散処理」→ DPS 研究会の full_name「マルチメディア通信と分散処理研究会」に含まれる
    // 長いチャンクが複数あっても 1 会議あたり最大 1 回（分野シグナル相当の重み）にする
    var jpChunks = (pt.match(/[\u3000-\u9fff]+/g) || []).filter(function (s) { return s.length >= 4; });
    if (jpChunks.length && conf.jp.length) {
      var jpHay = conf.jp.join(" ");
      var jpHit = jpChunks.some(function (chunk) { return jpHay.indexOf(chunk) !== -1; });
      if (jpHit) { score += 15; details.jp += 15; }
    }

    // tags 語彙一致（data-mining 等の領域タグ）
    conf.tags.forEach(function (t) {
      if (t && t.length > 3 && pt.indexOf(t) !== -1) { score += 10; details.tags += 10; }
    });

    // 掲載先タグ一致: この論文がこの会議に載ったことがある
    var venueHit = false;
    if (p.venue) {
      var nv = normKey(p.venue);
      if (nv.length >= 2) {
        var hay = [conf.key, conf.title, conf.full].filter(Boolean);
        if (nv.length === 2) {
          // 2 文字タグ（SC 等）は key と完全一致のときだけ許可（部分一致は誤爆する）
          venueHit = hay.some(function (h) { return h === nv; });
        } else {
          venueHit = hay.some(function (h) { return h && (h.indexOf(nv) !== -1 || nv.indexOf(h) !== -1); });
        }
        if (venueHit) { score += 40; details.venue += 40; }
      }
    }

    return { score: Math.min(100, score), venueHit: venueHit, details: details };
  }

  /* 全行のスコア: 平均と最大の加重平均（0.6×平均 + 0.4×最大）。
   * タグ付き論文 1 本の強シグナルが多数行の平均で薄まらないようにする。 */
  function scorePapers(r, lines) {
    if (!lines || !lines.length) return 0;
    var conf = confHay(r);
    var sum = 0, max = 0;
    for (var i = 0; i < lines.length; i++) {
      var s = scoreLine(r, lines[i], conf).score;
      sum += s;
      if (s > max) max = s;
    }
    var avg = sum / lines.length;
    return Math.round(avg * 0.6 + max * 0.4);
  }

  /* 論文モード用: 常時受付ジャーナル（tag: journal で締切なし）の行を合成する。
   * 特集号（締切付き）は通常の締切行で扱うため除外する。 */
  function journalRows(confs, now) {
    var out = [];
    (confs || []).forEach(function (conf) {
      if (!conf || !Array.isArray(conf.tags) || conf.tags.indexOf("journal") === -1) return;
      var hasDl = (conf.editions || []).some(function (e) { return (e.deadlines || []).length > 0; });
      if (hasDl) return;
      out.push({
        conf: conf,
        ed: { place: "", date_text: "" },
        dl: { label: "", round: 1 },
        kind: "journal", est: false,
        t: now, tLast: now,
        cats: conf.categories || [],
        tags: conf.tags || [],
        rankPairs: [],
        name: conf.title,
        year: null
      });
    });
    return out;
  }

  /* 論文モード用: 未来の投稿締切（abstract/paper）を持たない会議に限り、
   * 直近の過去投稿締切を 1 行だけ返す（RTSS 等「次回未発表」の会議を推薦圏に残す）。
   * 推定の過去行・開催イベント行は除外する。 */
  function pastRepresentatives(rows, now) {
    var byKey = {};
    var hasFuture = {};
    (rows || []).forEach(function (r) {
      if (r.kind !== "abstract" && r.kind !== "paper") return;
      var k = r.conf && r.conf.key;
      if (!k) return;
      if (r.t >= now) hasFuture[k] = true;
      if (r.t < now && !r.est && (!byKey[k] || r.t > byKey[k].t)) byKey[k] = r;
    });
    var out = [];
    Object.keys(byKey).forEach(function (k) {
      if (!hasFuture[k]) out.push(byKey[k]);
    });
    return out;
  }

  /* 論文モード: 会議単位に代表行を選ぶ。
   * 締切行優先 → 未来締切優先 → 早い締切 / 直近の過去。 */
  function pickRepresentative(rows, now) {
    var DAY = 86400000;
    var byKey = {};
    var isFuture = function (r) {
      return r.kind === "event" ? now < (r.tLast || r.t) + DAY : r.t >= now;
    };
    (rows || []).forEach(function (r) {
      var k = r.conf && (r.conf.key || "");
      if (!k) return;
      var cur = byKey[k];
      if (!cur) { byKey[k] = r; return; }
      if (cur.kind === "event" && r.kind !== "event") { byKey[k] = r; return; }
      if (r.kind === "event" && cur.kind !== "event") { return; }
      var cf = isFuture(cur), rf = isFuture(r);
      if (cf !== rf) { if (rf) byKey[k] = r; return; }
      if (cf ? r.t < cur.t : r.t > cur.t) byKey[k] = r;
    });
    return Object.keys(byKey).map(function (k) { return byKey[k]; });
  }

  /* 論文モードの並び: 適合度が第一、同点なら未来締切 → 常時受付ジャーナル → 過去締切。 */
  function comparePapers(a, b, now) {
    if (b._matchScore !== a._matchScore) { return b._matchScore - a._matchScore; }
    var DAY = 86400000;
    var aFut = a.kind === "event" ? now < (a.tLast || a.t) + DAY : a.t >= now;
    var bFut = b.kind === "event" ? now < (b.tLast || b.t) + DAY : b.t >= now;
    if (aFut !== bFut) { return aFut ? -1 : 1; }
    // 未来締切の会議をジャーナルより優先（締切がある方が行動可能）
    var aJ = a.kind === "journal";
    var bJ = b.kind === "journal";
    if (aJ !== bJ) { return aJ ? 1 : -1; }
    return a.t - b.t;
  }

  /* 掲載先タグが属するカテゴリを全会議から推定する。
   * 例: lines の venue="RTSS" が systems カテゴリの会議に一致 → ["systems"]。 */
  function venueCategories(lines, rows) {
    var out = {};
    (lines || []).forEach(function (p) {
      if (!p.venue) return;
      var nv = normKey(p.venue);
      if (nv.length <= 2) return;
      (rows || []).forEach(function (r) {
        var c = r.conf || {};
        var hay = [normKey(c.key), normKey(c.title), normKey(c.full_name)].filter(Boolean);
        var hit = hay.some(function (h) { return h && (h.indexOf(nv) !== -1 || nv.indexOf(h) !== -1); });
        if (hit) (r.cats || []).forEach(function (k) { out[k] = true; });
      });
    });
    return Object.keys(out);
  }

  function breakdown(r, lines) {
    var conf = confHay(r);
    var perLine = [];
    var venueHitAny = false;
    var agg = { domain: 0, name: 0, jp: 0, tags: 0, venue: 0 };
    for (var i = 0; i < (lines || []).length; i++) {
      var s = scoreLine(r, lines[i], conf);
      if (s.venueHit) venueHitAny = true;
      perLine.push({ score: s.score, venueHit: s.venueHit, details: s.details });
      Object.keys(agg).forEach(function (k) { agg[k] += s.details[k]; });
    }
    return { score: scorePapers(r, lines), venueHit: venueHitAny, perLine: perLine, agg: agg };
  }

  /* コサイン類似度（埋め込みベクトル）。0 ベクトルは 0 を返す。 */
  function cosine(a, b) {
    if (!a || !b || !a.length || a.length !== b.length) return 0;
    var dot = 0, na = 0, nb = 0;
    for (var i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  /* セマンティック適合度 0..100。
   * query: ユーザー論文の埋め込みベクトル、emb: {key: [...]} の会議埋め込み表。
   * 掲載先タグ付きの行が複数あってもクエリは 1 本に集約して類似度を出す。
   */
  function semanticScore(confKey, queryVec, emb) {
    if (!queryVec || !emb) return 0;
    var v = emb[confKey] || emb[(confKey || "").toLowerCase()];
    if (!v) return 0;
    var c = cosine(queryVec, v);
    return Math.round(Math.max(0, (c - 0.2) / 0.8) * 100); // 0.2 以下は 0、1.0 で 100
  }

  /* 論文テキスト（全行連結）を埋め込み用の単一クエリ文にする */
  function queryText(lines) {
    return (lines || [])
      .map(function (p) { return (p.title || "") + " " + (p.keywords || ""); })
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  var api = {
    DOMAIN_SIGNAL: DOMAIN_SIGNAL,
    parsePaperLines: parsePaperLines,
    autoDetectCats: autoDetectCats,
    venueCategories: venueCategories,
    scorePapers: scorePapers,
    breakdown: breakdown,
    journalRows: journalRows,
    pastRepresentatives: pastRepresentatives,
    pickRepresentative: pickRepresentative,
    comparePapers: comparePapers,
    cosine: cosine,
    semanticScore: semanticScore,
    queryText: queryText
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.Recommender = api;
})(typeof window !== "undefined" ? window : globalThis);
