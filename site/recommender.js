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
    hpc: ["hpc", "supercomputing", "parallel", "gpu", "fpga", "cuda", "mpi", "interconnect", "cluster"],
    systems: ["storage", "nvme", "cxl", "rdma", "kernel", "operating system", "memory", "virtual", "compiler", "real-time", "realtime", "embedded", "deterministic", "tsn"],
    networking: ["network", "sdn", "p4", "protocol", "wireless", "5g", "routing", "bpf", "ebpf", "packet"],
    ai: ["machine learning", "deep learning", "neural", "sysml", "gnn", "transformer", "llm", "ai"],
    security: ["security", "privacy", "crypto", "vulnerability", "binary", "enclave", "sgx", "confidential"]
  };

  var STOPWORDS = new Set(
    ("a an and or the of for in on to with via using based towards toward using design implementation " +
      "analysis study novel can we our this that from at by as is are be it its their these those paper papers " +
      "new towards between within across over under both each more most than then thus also such when while " +
      "which who what how why not no nor only into onto upon about above below out off they them he she his " +
      "her you your i me my mine do does did has have had will would could should may might must shall there " +
      "here been being was were am if else whether either neither yet still already just even though although " +
      "because system systems network networks").split(/\s+/)
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

  /* 会議側の照合文字列（key / title / full_name / tags） */
  function confHay(r) {
    var c = r.conf || {};
    return {
      key: normKey(c.key),
      title: normKey(c.title),
      full: normKey(c.full_name),
      tags: (c.tags || []).map(normKey)
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
    if (!pt.trim()) return { score: 0, venueHit: false };
    var score = 0;

    // 分野シグナル: 論文にキーワードがあり、会議がそのカテゴリを持つ
    Object.keys(DOMAIN_SIGNAL).forEach(function (dom) {
      if ((r.cats || []).indexOf(dom) === -1) return;
      var hitCount = DOMAIN_SIGNAL[dom].filter(function (kw) { return pt.indexOf(kw) !== -1; }).length;
      if (hitCount > 0) score += hitCount * 20;
    });

    // 会議名（title + full_name）の語彙一致
    var words = (conf.title + " " + conf.full).split(" ").filter(function (w) { return w.length > 3 && !STOPWORDS.has(w); });
    words.forEach(function (w) {
      if (pt.indexOf(w) !== -1) score += 15;
    });

    // tags 語彙一致（data-mining 等の領域タグ）
    conf.tags.forEach(function (t) {
      if (t && t.length > 3 && pt.indexOf(t) !== -1) score += 10;
    });

    // 掲載先タグ一致: この論文がこの会議に載ったことがある
    var venueHit = false;
    if (p.venue) {
      var nv = normKey(p.venue);
      if (nv.length > 2) {
        var hay = [conf.key, conf.title, conf.full].filter(Boolean);
        venueHit = hay.some(function (h) { return h && (h.indexOf(nv) !== -1 || nv.indexOf(h) !== -1); });
        if (venueHit) score += 40;
      }
    }

    return { score: Math.min(100, score), venueHit: venueHit };
  }

  /* 全行の平均（行ごとに cap してから平均）。0 行なら 0。 */
  function scorePapers(r, lines) {
    if (!lines || !lines.length) return 0;
    var conf = confHay(r);
    var sum = 0;
    for (var i = 0; i < lines.length; i++) {
      sum += scoreLine(r, lines[i], conf).score;
    }
    return Math.round(sum / lines.length);
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

  /* 論文モードの並び: 適合度が第一、同点なら未来締切（開催中・未到来）を優先。 */
  function comparePapers(a, b, now) {
    if (b._matchScore !== a._matchScore) { return b._matchScore - a._matchScore; }
    var DAY = 86400000;
    var aFut = a.kind === "event" ? now < (a.tLast || a.t) + DAY : a.t >= now;
    var bFut = b.kind === "event" ? now < (b.tLast || b.t) + DAY : b.t >= now;
    if (aFut !== bFut) { return aFut ? -1 : 1; }
    return a.t - b.t;
  }

  function breakdown(r, lines) {
    var conf = confHay(r);
    var perLine = [];
    var venueHitAny = false;
    for (var i = 0; i < (lines || []).length; i++) {
      var s = scoreLine(r, lines[i], conf);
      if (s.venueHit) venueHitAny = true;
      perLine.push({ score: s.score, venueHit: s.venueHit });
    }
    return { score: scorePapers(r, lines), venueHit: venueHitAny, perLine: perLine };
  }

  var api = {
    DOMAIN_SIGNAL: DOMAIN_SIGNAL,
    parsePaperLines: parsePaperLines,
    autoDetectCats: autoDetectCats,
    scorePapers: scorePapers,
    breakdown: breakdown,
    pickRepresentative: pickRepresentative,
    comparePapers: comparePapers
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.Recommender = api;
})(typeof window !== "undefined" ? window : globalThis);
