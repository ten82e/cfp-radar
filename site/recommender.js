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
 *   safeExternalUrl(value)     → HTTP/HTTPS または相対 URL、不正な URL は ""
 */
((root) => {
  /* 既存 template.html の DOMAIN_SIGNAL と同一（ここが正典）
   * 変更時は template.html 側の重複定義も同じ内容に保つこと。 */
  var DOMAIN_SIGNAL = {
    hpc: [
      "hpc",
      "supercomputing",
      "parallel",
      "gpu",
      "fpga",
      "cuda",
      "mpi",
      "interconnect",
      "cluster",
      "ハイパフォーマンス",
      "スーパーコンピュータ",
      "並列",
    ],
    systems: [
      "storage",
      "nvme",
      "cxl",
      "rdma",
      "kernel",
      "operating system",
      "memory",
      "virtual",
      "compiler",
      "real-time",
      "realtime",
      "embedded",
      "deterministic",
      "tsn",
      "ストレージ",
      "カーネル",
      "分散システム",
      "ミドルウェア",
      "オペレーティングシステム",
    ],
    networking: [
      "network",
      "sdn",
      "p4",
      "protocol",
      "wireless",
      "5g",
      "routing",
      "bpf",
      "ebpf",
      "packet",
      "ネットワーク",
      "通信",
      "ルーティング",
      "無線",
    ],
    ai: [
      "machine learning",
      "deep learning",
      "neural",
      "sysml",
      "gnn",
      "transformer",
      "llm",
      "ai",
      "機械学習",
      "深層学習",
      "ニューラル",
      "生成",
    ],
    security: [
      "security",
      "privacy",
      "crypto",
      "vulnerability",
      "binary",
      "enclave",
      "sgx",
      "confidential",
      "セキュリティ",
      "プライバシー",
      "暗号",
    ],
    db: [
      "database",
      "query",
      "sql",
      "index",
      "data mining",
      "data management",
      "key-value",
      "oltp",
      "olap",
      "vector",
      "データベース",
      "クエリ",
      "データマイニング",
    ],
    graphics: [
      "graphics",
      "rendering",
      "mesh",
      "animation",
      "multimedia",
      "video",
      "audio",
      "image processing",
      "computer vision",
      "3d",
      "ビジュアライゼーション",
      "可視化",
      "映像",
      "グラフィックス",
    ],
    hci: [
      "human-computer",
      "user interface",
      "usability",
      "interaction",
      "accessibility",
      "touch",
      "augmented reality",
      "virtual reality",
      "ヒューマン",
      "ユーザインタフェース",
      "ユーザビリティ",
    ],
    theory: [
      "algorithm",
      "complexity",
      "automata",
      "graph theory",
      "approximation",
      "lower bound",
      "combinatorial",
      "formal",
      "verification",
      "アルゴリズム",
      "計算量",
      "複雑性",
    ],
  };

  var STOPWORDS = new Set(
    (
      "a an and or the of for in on to with via using based towards toward using design implementation " +
      "analysis study novel can we our this that from at by as is are be it its their these those paper papers " +
      "new towards between within across over under both each more most than then thus also such when while " +
      "which who what how why not no nor only into onto upon about above below out off they them he she his " +
      "her you your i me my mine do does did has have had will would could should may might must shall there " +
      "here been being was were am if else whether either neither yet still already just even though although " +
      "because system systems network networks conference symposium workshop international annual proceedings " +
      "ieee acm usenix journal letters transactions magazine association machinery electronics engineers " +
      "special interest group review about applications application computer computing science institute technical " +
      // 会議名によく出るが内容語としては弱い語（Signal Processing 等の誤爆防止）
      "processing technology advanced modern research recent emerging"
    ).split(/\s+/),
  );

  /* 1行: "タイトル | キーワード | 掲載先(任意)" または "タイトル<TAB>キーワード<TAB>掲載先" */
  function parsePaperLines(text) {
    if (!text) return [];
    return String(text)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        var parts = l.split(/\s*\|\s*/);
        if (parts.length === 1) parts = l.split(/\t+/);
        return {
          title: (parts[0] || "").trim(),
          keywords: (parts[1] || "").trim(),
          venue: (parts[2] || "").trim(),
        };
      })
      .filter((p) => p.title);
  }

  /* 掲載先・会議名の照合用正規化。機能語（the/of/and/& 等）を除いて
   * 「Security & Privacy」と「Security and Privacy」のような表記ゆれを吸収する。
   * 両側（venue 側・会議側）を同じ規則で正規化するので一致判定は一貫する。
   */
  var FILLER = /\b(a|an|the|and|or|of|for|in|on|at|to|by|with)\b/g;
  function normKey(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .replace(FILLER, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  /* 掲載先タグの略称エイリアス: 正規化した venue 文字列 → 会議 key のリスト。
   * 例: 「SP」は 2 文字のため完全一致（key）しか効かず、key "s-p" には一致しない。
   * 「s&p」→「s p」はタイトル正規化で拾えるためエイリアス不要。
   */
  var VENUE_ALIASES = {
    sp: ["s-p"], // IEEE Symposium on Security & Privacy
    snp: ["s-p"],
  };

  /* 会議名/代表論文語彙マッチングの IDF 重み表 {name: {word: 0..1}, paper: {word: 0..1}}
   * （null なら一律 15 点）。会議名での出現頻度が高い語（network 等）は加点を抑え、
   * 希少語（deterministic 等）を重くする。papers 語は papers 側の df（汎用語が広く
   * 出現する）で減衰する。ブラウザ/ベンチが setNameIdf で設定する（会議集合は
   * 実行時にしか分からない）。
   */
  var idfMap = null;
  function setNameIdf(map) {
    idfMap = map || null;
  }

  /* skipEmb 会議（rtss/ecrts/usenix-security）の論文個別ベクトル表（R16）。
   * semanticScore が max 類似度を取るときに使う。英語クエリのみ（多言語モデルの
   * クエリに英語モデルの論文ベクトルを混ぜると R12 の言語別分離設計を壊す）。
   * null なら従来の会議名ベクトルのみ（A/B 用）。
   */
  var paperVecsState = null;
  function setPaperVecs(pv) {
    paperVecsState = pv || null;
  }

  /* 全会議から IDF 重み表を作る（R14 で {name, paper} の 2 マップ化）。
   * ブラウザ側はデータロード後にこの結果を setNameIdf に渡す（buildNameIdf で計算）。
   * ベンチの --idf と同じ定義。
   *
   * R12 実測: 代表採択論文語彙（papers）の汎用語（machine/deep/cache 等）は全会議に
   * 現れ、そのまま 1 語 15 点だと会議間で衝突して誤爆する。IDF で減衰すると
   * golden EN（実論文）top1 が 25.0→37.5% に改善。
   *
   * R14 実測（2 段階）:
   * 1. 従来の「名前 + papers 同一 df」だと、papers を追加した会議（rtss/ecrts）の
   *    論文語が名前語の df を汚染し、名前語の IDF が薄まって合成ベンチ top1 が
   *    84.8→76.9 に悪化 → df を種類別に分離。
   * 2. それでも「名前にも papers にも出る語」（memory 等）は名前 df を優先したため、
   *    papers マッチでも名前由来の高重みになり、rtss/ecrts の papers 語彙が
   *    無関係クエリ（Beehive の memory、private optimization の optimization）を奪った。
   *    → マッチ元（名前語 / papers 語）ごとに別マップを使う。
   */
  function buildNameIdf(confs) {
    var nameDf = {};
    var paperDf = {};
    var safeConfs = Array.isArray(confs) ? confs : [];
    safeConfs.forEach((c) => {
      if (!c || typeof c !== "object") return;
      var seenName = {};
      var seenPaper = {};
      normKey((c.title || "") + " " + (c.full_name || ""))
        .split(" ")
        .forEach((w) => {
          if (w.length > 3 && !STOPWORDS.has(w) && !seenName[w]) {
            seenName[w] = true;
            nameDf[w] = (nameDf[w] || 0) + 1;
          }
        });
      var papers = Array.isArray(c.papers)
        ? c.papers
        : typeof c.papers === "string" && c.papers.trim() !== ""
          ? [c.papers.trim()]
          : [];
      papers.forEach((t) => {
        normKey(t || "")
          .split(" ")
          .forEach((w) => {
            if (w.length > 3 && !STOPWORDS.has(w) && !seenPaper[w]) {
              seenPaper[w] = true;
              paperDf[w] = (paperDf[w] || 0) + 1;
            }
          });
      });
    });
    var N = safeConfs.length;
    var idfOf = (d) => (N <= 0 ? 0 : Math.log(1 + N / (d + 1)) / Math.log(1 + N));
    var mk = (df) => {
      var out = {};
      Object.keys(df).forEach((w) => {
        out[w] = idfOf(df[w]);
      });
      return out;
    };
    return { name: mk(nameDf), paper: mk(paperDf) };
  }

  /* サブシグナルの内部点数。R11 の実測スイープ結果:
   *   - domain/name/tags/venue は R1 以来の値（15/15/10/40）が最適 — 増減とも悪化
   *     （name=25: -2.7, name=10: -0.4/-1.6, domain=30: top5 -0.9, tags=0: -0.7）
   *   - jp は 15→30 で日本語ゴールデン top1 +2.8pt、EN/JP synthetic は不変
   *     （日本語チャンク一致は日本語クエリでのみ発火するため EN に影響なし）
   *   - paper（代表採択論文語彙）は name と同額の 15（R12 実測で最適。低い値は
   *     golden EN を大きく損なう — R14 スイープ: paper=10 で top5 66.7→57.8）。
   *     配線は R14 に復旧（R12 末〜R13 の編集で SIG_WEIGHTS.paper が未使用化）。
   * setSigWeights({domain:.., name:.., paper:.., jp:.., tags:.., venue:.., nameOnce: bool}) で
   * ブラウザ/ベンチから上書きできる。nameOnce は会議名一致を「先頭 1 語のみ固定加点」
   * （語数に比例させない）にする実験用フラグ。
   */
  var SIG_WEIGHTS = {
    domain: 15,
    name: 15,
    paper: 15,
    paperCap: 4,
    jp: 30,
    tags: 10,
    venue: 40,
    nameOnce: false,
  };
  function setSigWeights(w) {
    if (!w) return;
    Object.keys(SIG_WEIGHTS).forEach((k) => {
      // nameOnce は boolean フラグ（先頭 1 語固定加点）なので boolean も適用する。
      // SIG_WEIGHTS の他キーは全て数値で、boolean を許可しても混入しない。
      if (typeof w[k] === "number" || typeof w[k] === "boolean") SIG_WEIGHTS[k] = w[k];
    });
  }

  /* メタデータタグ（本文の英単語と偶然一致して誤加点する汎用語）。
   * R11 実測: workshop(36 会議)/journal(18)/niche(43)/domestic-jp/special-issue は
   * トピックではなく属性のため、tags 語彙一致から除外する（トピックタグは残す）。
   */
  var GENERIC_TAGS = new Set([
    "niche",
    "workshop",
    "domestic-jp",
    "journal",
    "special-issue",
    "niche-jp",
  ]);

  /* 代表採択論文語彙（conf.papers）のマッチで除外する汎用語。
   * 名前語の STOPWORDS とは別 — 論文タイトルに頻出するが会議の識別に寄与しない語。
   * R18 実測: rtss の papers 語彙（self/general/framework 等）が data2vec クエリに
   * 5 ヒット（self/general/framework/vision/language）して 49 点を稼ぎ、sem が効く
   * icml（vocab 48 + sem 9）を blendScore の減衰で下回って top1 を奪った。
   * vision/language 等は会議名では識別語だが papers では汎用 — マッチ元が papers な
   * のでここで除外しても名前語マッチ（nameWords）には影響しない。
   */
  var GENERIC_PAPER_WORDS = new Set([
    "self",
    "general",
    "framework",
    "approach",
    "method",
    "based",
    "using",
    "towards",
    "improving",
    "understanding",
    "learning",
    "analysis",
    "study",
    "design",
    "performance",
    // efficient/scalable は R19 で一度入れたが撤回 — 論文タイトル頻出語で df が高く
    // IDF で自然減衰される。GENERIC に入れると正当なマッチ（Carbon-efficient ↔ papers の
    // efficient 等）まで消し、GREEN→nsdi の golden が top5 から脱落した（実測）。
  ]);

  /* 会議側の照合文字列（key / title / full_name / tags / 日本語表記 / 代表論文語彙） */
  function confHay(r) {
    var c = (r && r.conf) || r || {};
    return {
      key: normKey(c.key),
      title: normKey(c.title),
      full: normKey(c.full_name),
      tags: (c.tags || []).map(normKey),
      jp: ((c.title || "") + " " + (c.full_name || "")).match(/[\u3000-\u9fff]+/g) || [],
      // 代表採択論文タイトル（実データが持つ場合のみ）。語彙一致の対象を
      // 「会議名」から「会議の実際の採択領域」に広げる（R12 実測）。
      papers: (c.papers || []).map(normKey),
    };
  }

  /* 分野自動判定: 全論文テキストで各分野シグナルのヒット数を数える */
  function autoDetectCats(lines) {
    if (!lines || !lines.length) return [];
    var text = lines
      .map((p) => (((p && p.title) || "") + " " + ((p && p.keywords) || "")).trim())
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    var hits = [];
    var hay = expandJp(text) + " " + text;
    Object.keys(DOMAIN_SIGNAL).forEach((dom) => {
      var n = DOMAIN_SIGNAL[dom].filter((kw) => hay.indexOf(kw) !== -1).length;
      if (n > 0) hits.push({ dom: dom, n: n });
    });
    hits.sort((a, b) => b.n - a.n);
    return hits.map((h) => h.dom);
  }

  /* 1行ぶんのスコア (0..100)。venueHit は掲載先タグ一致なら true */
  function scoreLine(r, p, conf) {
    if (!p)
      return {
        score: 0,
        venueHit: false,
        details: { domain: 0, name: 0, jp: 0, tags: 0, venue: 0 },
      };
    var pt = ((p.title || "") + " " + (p.keywords || "")).trim().toLowerCase();
    if (!pt)
      return {
        score: 0,
        venueHit: false,
        details: { domain: 0, name: 0, jp: 0, tags: 0, venue: 0 },
      };
    var score = 0;
    var details = { domain: 0, name: 0, jp: 0, tags: 0, venue: 0 };
    // 内側ブロックで使う var は関数ルートに宣言を集約（biome noInnerDeclarations）
    var wgt;
    var jpHay;
    var jpHit;
    var rawTag;
    var nv;
    var hay;
    var rawHay;
    var rt;
    var aliases;
    var hl;
    var c;

    // 注: 日本語→英語展開（expandJp）はスコアリングに使わない。
    // 実測（ベンチマーク A/B）: 展開語が英語名の会議に広く一致して誤爆し、
    // 日本語ゴールデンセット top1 が 42%→16% に悪化した。展開は
    // 分野自動判定（autoDetectCats）の表示用にのみ使う。

    // 分野シグナル: 論文にキーワードがあり、会議がそのカテゴリを持つ。
    // ヒット数ではなく「カテゴリにヒットしたか」で +SIG_WEIGHTS.domain（累積しない）。
    Object.keys(DOMAIN_SIGNAL).forEach((dom) => {
      if ((r.cats || []).indexOf(dom) === -1) return;
      var hit = DOMAIN_SIGNAL[dom].some((kw) => pt.indexOf(kw) !== -1);
      if (hit) {
        score += SIG_WEIGHTS.domain;
        details.domain += SIG_WEIGHTS.domain;
      }
    });

    // 会議名（title + full_name）の語彙一致（一般語は STOPWORDS で除外）。
    // 代表採択論文語彙（conf.papers）は「会議の実際の採択領域」を表すが、汎用語
    // （cache/machine/deep 等）が全会議の papers に現れて誤爆する。
    // R14 実測: SIG_WEIGHTS.paper は定義だけで配線されておらず（name と同額 15 のまま）、
    // rtss/ecrts の papers 語彙（memory/optimization/analysis 等）が無関係クエリ
    // （memory safety / private optimization 等）へ交差マッチした。名前語と papers 語を
    // 分離し、papers 語は SIG_WEIGHTS.paper（既定 10）で軽くする。
    // IDF 重み表があれば希少語を重く、無ければ一律 SIG_WEIGHTS.name / paper 点。
    // nameOnce: 先頭 1 語の固定加点のみ（語数に比例させない実験用）
    // 代表論文語彙は英語クエリでのみ使う（日本語クエリでは日本語チャンク一致が主役で、
    // 英語の代表論文語彙は英語キーワード（nvme/storage 等）を持つ日本語論文クエリと
    // 衝突して誤爆する — R12 実測で s-p が icml に奪われる等の副作用を確認）。
    // また、掲載先タグ付き行（p.venue）でも使わない — タグの絶対性（venueHit +40）を
    // 守るため（R13 実測: nsdi/osdi の papers 語彙 "scheduling" が RTSS タグ付き行を
    // 超えて順位を乱した）。
    var nameWords = (conf.title + " " + conf.full)
      .split(" ")
      .filter((w) => w.length > 3 && !STOPWORDS.has(w));
    var paperWords =
      hasJapanese(pt) || p.venue
        ? []
        : conf.papers
            .join(" ")
            .split(" ")
            .filter((w) => w.length > 3 && !STOPWORDS.has(w) && !GENERIC_PAPER_WORDS.has(w));
    var nameGiven = false;
    nameWords.forEach((w) => {
      if (!wordInText(pt, w)) return;
      if (SIG_WEIGHTS.nameOnce && nameGiven) return;
      wgt =
        idfMap && idfMap.name && idfMap.name[w]
          ? Math.max(2, Math.round(SIG_WEIGHTS.name * idfMap.name[w]))
          : SIG_WEIGHTS.name;
      score += wgt;
      details.name += wgt;
      nameGiven = true;
    });
    // 行あたりの paper 語彙ヒット数に上限（SIG_WEIGHTS.paperCap）。
    // R14 実測: 論文が多い会議（rtss 22 本等）の汎用語（vision/model/real-time 等）が
    // 数ヒットでスコア上限 100 に達し、グラフィクス/マルチメディア系の他クエリ
    // （3dv/siggraph/icassp 等 39 件）を奪った。複数ヒットは「採択領域の一致」という
    // 1 信号と見なす（日本語チャンク一致と同じ考え方）。
    var paperHits = 0;
    paperWords.forEach((w) => {
      if (!wordInText(pt, w)) return;
      if (paperHits >= SIG_WEIGHTS.paperCap) return;
      paperHits++;
      wgt =
        idfMap && idfMap.paper && idfMap.paper[w]
          ? Math.max(2, Math.round(SIG_WEIGHTS.paper * idfMap.paper[w]))
          : SIG_WEIGHTS.paper;
      score += wgt;
      details.name += wgt;
    });

    // 日本語の部分一致: 論文の日本語チャンク（4 文字以上）が会議名の日本語に含まれれば加点
    // 例: 論文に「分散処理」→ DPS 研究会の full_name「マルチメディア通信と分散処理研究会」に含まれる
    // 長いチャンクが複数あっても 1 会議あたり最大 1 回（分野シグナル相当の重み）にする
    var jpChunks = (pt.match(/[\u3000-\u9fff]+/g) || []).filter((s) => s.length >= 4);
    if (jpChunks.length && conf.jp.length) {
      jpHay = conf.jp.join(" ");
      jpHit = jpChunks.some((chunk) => jpHay.indexOf(chunk) !== -1);
      if (jpHit) {
        score += SIG_WEIGHTS.jp;
        details.jp += SIG_WEIGHTS.jp;
      }
    }

    // tags 語彙一致（data-mining 等の領域タグ。GENERIC_TAGS は属性なので除外）
    conf.tags.forEach((t) => {
      if (!t || GENERIC_TAGS.has(t) || t.length <= 3) return;
      if (pt.indexOf(t) !== -1) {
        score += SIG_WEIGHTS.tags;
        details.tags += SIG_WEIGHTS.tags;
      }
    });

    // 掲載先タグ一致: この論文がこの会議に載ったことがある
    var venueHit = false;
    if (p.venue) {
      rawTag = String(p.venue).trim().replace(/\s+/g, " ");
      nv = normKey(p.venue);
      hay = [conf.key, conf.title, conf.full].filter(Boolean);
      // 原文（日本語含む）照合: 「情報処理学会 DPS 研究会」タグが会議名に含まれれば一致。
      // 短いタグ（ISC 等）は完全一致のみ（ISCA への部分一致誤爆を防ぐ）
      c = (r && r.conf) || r || {};
      rawHay = [(c.title || "").replace(/\s+/g, " "), (c.full_name || "").replace(/\s+/g, " ")];
      rt = rawTag.toLowerCase();
      venueHit =
        rawTag.length >= 2 &&
        rawHay.some((h) => {
          if (!h) return false;
          hl = h.toLowerCase();
          return rawTag.length <= 3 ? hl === rt : hl.indexOf(rt) !== -1 || rt.indexOf(hl) !== -1;
        });
      if (!venueHit && nv.length >= 2) {
        aliases = VENUE_ALIASES[nv];
        if (nv.length <= 3) {
          // 2〜3 文字タグ（SC / ISC / dps 等）は完全一致のみ（部分一致は誤爆する）
          venueHit = hay.some((h) => h === nv);
        } else {
          venueHit = hay.some((h) => h && (h.indexOf(nv) !== -1 || nv.indexOf(h) !== -1));
        }
        // 略称エイリアス（例: SP → s-p）は key 単位で照合する（両側を normKey で正規化）
        if (!venueHit && aliases) {
          venueHit = aliases.some((k) => normKey(k) === conf.key);
        }
      }
      if (venueHit) {
        score += SIG_WEIGHTS.venue;
        details.venue += SIG_WEIGHTS.venue;
      }
    }

    return { score: Math.min(100, score), venueHit: venueHit, details: details };
  }

  /* 全行のスコア: 平均と最大の加重平均（0.6×平均 + 0.4×最大）。
   * タグ付き論文 1 本の強シグナルが多数行の平均で薄まらないようにする。 */
  function scorePapers(r, lines) {
    if (!r || !lines || !lines.length) return 0;
    var conf = confHay(r);
    var sum = 0,
      max = 0;
    for (var i = 0; i < lines.length; i++) {
      var s = scoreLine(r, lines[i], conf).score;
      sum += s;
      if (s > max) max = s;
    }
    var avg = sum / lines.length;
    return Math.round(avg * 0.6 + max * 0.4);
  }

  /* ランクフィルタ: rankPairs ("ccf:A" 等) のグレードを厳密比較する。
   * indexOf の部分一致だと "A" が "core:A*" に誤マッチする (A* は A ではない)。 */
  function rankMatches(rankPairs, grade) {
    return (rankPairs || []).some((p) => p.slice(p.indexOf(":") + 1) === grade);
  }

  /* 論文モード・常時受付用: 常時受付ジャーナル（tag: journal で締切なし）の行を合成する。
   * 特集号（締切付き）は通常の締切行で扱うため除外する。 */
  function journalRows(confs, now) {
    var out = [];
    var safeConfs = Array.isArray(confs) ? confs : [];
    safeConfs.forEach((conf) => {
      if (!conf || typeof conf !== "object") return;
      var tags = Array.isArray(conf.tags)
        ? conf.tags
        : typeof conf.tags === "string" && conf.tags.trim() !== ""
          ? [conf.tags.trim()]
          : [];
      if (tags.indexOf("journal") === -1) return;
      var hasDl = (conf.editions || []).some(
        (e) => e && e.deadlines && Array.isArray(e.deadlines) && e.deadlines.length > 0,
      );
      if (hasDl) return;
      var pairs = [];
      if (conf.rank && typeof conf.rank === "object") {
        Object.keys(conf.rank).forEach((rk) => {
          if (conf.rank[rk]) {
            pairs.push(rk + ":" + conf.rank[rk]);
          }
        });
      }
      var baseHay = [conf.title, conf.full_name, conf.key].filter(Boolean).join(" ").toLowerCase();
      var cats = Array.isArray(conf.categories)
        ? conf.categories
        : typeof conf.categories === "string" && conf.categories.trim() !== ""
          ? [conf.categories.trim()]
          : [];
      out.push({
        conf: conf,
        ed: { place: "", date_text: "" },
        dl: { label: "", round: 1 },
        kind: "journal",
        est: false,
        t: now,
        tLast: now,
        cats: cats,
        tags: tags,
        rankPairs: pairs,
        hay: baseHay + " journal 常時受付",
        name: conf.title,
        year: null,
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
    (rows || []).forEach((r) => {
      if (r.kind !== "abstract" && r.kind !== "paper") return;
      var k = r.conf && r.conf.key;
      if (!k) return;
      if (r.t >= now) hasFuture[k] = true;
      if (r.t < now && !r.est && (!byKey[k] || r.t > byKey[k].t)) byKey[k] = r;
    });
    var out = [];
    Object.keys(byKey).forEach((k) => {
      if (!hasFuture[k]) out.push(byKey[k]);
    });
    return out;
  }

  /* 論文モード: 会議単位に代表行を選ぶ。
   * 締切行優先 → 未来締切優先 → 早い締切 / 直近の過去。 */
  function pickRepresentative(rows, now) {
    var DAY = 86400000;
    var byKey = {};
    var isFuture = (r) => (r.kind === "event" ? now < (r.tLast || r.t) + DAY : r.t >= now);
    (rows || []).forEach((r) => {
      var k = r.conf && (r.conf.key || "");
      if (!k) return;
      var cur = byKey[k];
      if (!cur) {
        byKey[k] = r;
        return;
      }
      if (cur.kind === "event" && r.kind !== "event") {
        byKey[k] = r;
        return;
      }
      if (r.kind === "event" && cur.kind !== "event") {
        return;
      }
      var cf = isFuture(cur),
        rf = isFuture(r);
      if (cf !== rf) {
        if (rf) byKey[k] = r;
        return;
      }
      if (cf ? r.t < cur.t : r.t > cur.t) byKey[k] = r;
    });
    return Object.keys(byKey).map((k) => byKey[k]);
  }

  /* 論文モードの並び: 適合度が第一、同点なら未来締切 → 常時受付ジャーナル → 過去締切。 */
  function comparePapers(a, b, now) {
    if (b._matchScore !== a._matchScore) {
      return b._matchScore - a._matchScore;
    }
    var DAY = 86400000;
    var aFut = a.kind === "event" ? now < (a.tLast || a.t) + DAY : a.t >= now;
    var bFut = b.kind === "event" ? now < (b.tLast || b.t) + DAY : b.t >= now;
    if (aFut !== bFut) {
      return aFut ? -1 : 1;
    }
    // 未来締切の会議をジャーナルより優先（締切がある方が行動可能）
    var aJ = a.kind === "journal";
    var bJ = b.kind === "journal";
    if (aJ !== bJ) {
      return aJ ? 1 : -1;
    }
    return a.t - b.t;
  }

  /* 掲載先タグが属するカテゴリを全会議から推定する。
   * 例: lines の venue="RTSS" が systems カテゴリの会議に一致 → ["systems"]。 */
  function venueCategories(lines, rows) {
    var out = {};
    (lines || []).forEach((p) => {
      if (!p.venue) return;
      var nv = normKey(p.venue);
      if (nv.length <= 2) return;
      (rows || []).forEach((r) => {
        var c = r.conf || {};
        var hay = [normKey(c.key), normKey(c.title), normKey(c.full_name)].filter(Boolean);
        var hit = hay.some((h) => h && (h.indexOf(nv) !== -1 || nv.indexOf(h) !== -1));
        if (hit)
          (r.cats || []).forEach((k) => {
            out[k] = true;
          });
      });
    });
    return Object.keys(out);
  }

  function breakdown(r, lines) {
    if (!r)
      return {
        score: 0,
        venueHit: false,
        perLine: [],
        agg: { domain: 0, name: 0, jp: 0, tags: 0, venue: 0 },
      };
    var conf = confHay(r);
    var perLine = [];
    var venueHitAny = false;
    var agg = { domain: 0, name: 0, jp: 0, tags: 0, venue: 0 };
    for (var i = 0; i < (lines || []).length; i++) {
      var s = scoreLine(r, lines[i], conf);
      if (s.venueHit) venueHitAny = true;
      perLine.push({ score: s.score, venueHit: s.venueHit, details: s.details });
      Object.keys(agg).forEach((k) => {
        agg[k] += s.details[k];
      });
    }
    return { score: scorePapers(r, lines), venueHit: venueHitAny, perLine: perLine, agg: agg };
  }

  /* 掲載先タグ（例: "IEEE RTSS"）に一致する会議のリストを返す。
   * scoreLine の venueHit と同じ照合規則（normKey + 略称エイリアス + 原文）。
   * セマンティックの擬似関連性フィードバック（PRF）に使う — タグ付き論文の
   * 会議埋め込みをクエリに混ぜることで「自分が載せた所と似た会議」を強く拾う。
   * 日本語タグ（例: 「情報処理学会 DPS 研究会」）は normKey が日本語を消して
   * 「dps」等の短い断片になり、誤爆（IPDPS 等）の元になるため、原文も照合する。
   */
  function matchVenueTag(tag, confs) {
    var raw = String(tag || "")
      .trim()
      .replace(/\s+/g, " ");
    var nv = normKey(tag);
    if (raw.length < 2 && nv.length < 2) return [];
    var out = [];
    (confs || []).forEach((item) => {
      if (!item) return;
      var c = item.conf || item;
      var key = normKey(c.key);
      var hay = [key, normKey(c.title), normKey(c.full_name)].filter(Boolean); // 原文（日本語含む）: 空白正規化したタグが会議の名称に含まれれば一致。
      // 短いタグ（ISC 等）は完全一致のみ（ISCA への部分一致誤爆を防ぐ）
      var rawHay = [(c.title || "").replace(/\s+/g, " "), (c.full_name || "").replace(/\s+/g, " ")];
      var rl = raw.toLowerCase();
      var hit =
        raw.length >= 2 &&
        rawHay.some((h) => {
          if (!h) return false;
          var hl = h.toLowerCase();
          return raw.length <= 3 ? hl === rl : hl.indexOf(rl) !== -1 || rl.indexOf(hl) !== -1;
        });
      // normKey 照合: 2〜3 文字は完全一致のみ（「dps」が IPDPS に部分一致する誤爆防止）
      if (!hit && nv.length >= 2) {
        if (nv.length <= 3) {
          hit = hay.some((h) => h === nv);
        } else {
          hit = hay.some((h) => h && (h.indexOf(nv) !== -1 || nv.indexOf(h) !== -1));
        }
        if (!hit) {
          var aliases = VENUE_ALIASES[nv];
          if (aliases) hit = aliases.some((k) => normKey(k) === key);
        }
      }
      if (hit) out.push(item);
    });
    return out;
  }

  /* 2 つの埋め込みベクトルを重み wA（a の重み）で合成し L2 正規化する。
   * PRF 用: a = 論文クエリ、b = 掲載先会議の埋め込み。 */
  function blendVectors(a, b, wA) {
    if (!a || !b || a.length !== b.length) return a;
    var w = typeof wA === "number" ? wA : 0.7;
    var out = new Array(a.length);
    var sum = 0;
    for (var i = 0; i < a.length; i++) {
      out[i] = w * a[i] + (1 - w) * b[i];
      sum += out[i] * out[i];
    }
    var n2 = Math.sqrt(sum);
    if (!n2) return a;
    for (var j = 0; j < out.length; j++) out[j] /= n2;
    return out;
  }

  /* コサイン類似度（埋め込みベクトル）。0 ベクトルは 0 を返す。 */
  function cosine(a, b) {
    if (!a || !b || !a.length || a.length !== b.length) return 0;
    var dot = 0,
      na = 0,
      nb = 0;
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
   * paperVecs（R16）: skipEmb 会議（rtss/ecrts/usenix-security）の論文個別ベクトル表。
   * 与えた場合は「会議名との類似度」と「採択論文どれかとの類似度」の max を取る
   * （R14 で平均重心の汎用化を避けるため埋め込みから論文を外した副作用 = 論文タイトル
   * からセマンティックに発見されない、を解消する。R13 の「平均」は却下済み、max は R16 実測）。
   */
  function semanticScore(confKey, queryVec, emb, paperVecs) {
    if (!queryVec || !emb) return 0;
    var v = emb[confKey] || emb[(confKey || "").toLowerCase()];
    if (!v) return 0;
    var c = cosine(queryVec, v);
    var pvs = (paperVecs || paperVecsState) && (paperVecs || paperVecsState)[confKey];
    if (pvs && pvs.length) {
      for (var i = 0; i < pvs.length; i++) {
        var pc = cosine(queryVec, pvs[i]);
        if (pc > c) c = pc;
      }
    }
    return Math.round(Math.max(0, (c - 0.2) / 0.8) * 100); // 0.2 以下は 0、1.0 で 100
  }

  /* 会議プロファイルの英語比率 0..1。
   * embeddings.ts の profileTexts と同じ構成（title + full_name + tags）で測る。
   * 日本語名が主体の会議（IPSJ 特集号等）は英語モデルの埋め込みが「カテゴリ重心の
   * ぼやけ」になり、英語クエリへの誤マッチの元になる。英語クエリではこの比率で
   * セマンティックスコアを減衰させる（日本語クエリは多言語モデルなので減衰しない）。
   */
  function englishRatio(conf) {
    var c = conf || {};
    var text = [c.title, c.full_name, (c.tags || []).join(" ")].filter(Boolean).join(" ");
    if (!text) return 1;
    var letters = text.replace(/[^a-zA-Z]/g, "").length;
    return letters / text.length;
  }

  /* 会議名・代表論文の語がクエリテキストに語境界で現れるか（R19）。
   * 部分文字列一致（indexOf）だと、会議名の略語 trans/syst がクエリの
   * Transcompiling/Systems に誤マッチする（QiMeng→ieice 46 点の実測原因）。
   * 単複形・活用形（bandit/bandits, process/processes, memory/memories, search/searches）は
   * 正当なマッチなので双方向に対称照合する。
   */
  function wordInText(hay, w) {
    if (!hay || !w) return false;
    var safeW = String(w)
      .toLowerCase()
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!safeW) return false;
    var re;
    if (safeW.endsWith("ies") && safeW.length > 4) {
      re = safeW.slice(0, -3) + "(?:y|ies)";
    } else if (safeW.endsWith("y") && safeW.length > 3 && !/[aeiou]y$/.test(safeW)) {
      re = safeW.slice(0, -1) + "(?:y|ies)";
    } else if (safeW.endsWith("sses") && safeW.length > 5) {
      re = safeW.slice(0, -2) + "(?:es)?";
    } else if (safeW.endsWith("ss")) {
      re = safeW + "(?:es)?";
    } else if (/(?:ches|shes|xes|zes)$/.test(safeW) && safeW.length > 4) {
      re = safeW.slice(0, -2) + "(?:es)?";
    } else if (/(?:ch|sh|x|z)$/.test(safeW)) {
      re = safeW + "(?:es)?";
    } else if (safeW.endsWith("s")) {
      re = safeW.slice(0, -1) + "s?";
    } else {
      re = safeW + "s?";
    }
    return new RegExp("\\b" + re + "\\b", "i").test(String(hay));
  }

  /* クエリの内容語数（英語）。ブレンドの語彙重みの適応に使う。
   * 一般語（STOPWORDS）と短語は数えない — 入力が短いほど語彙シグナルが疎なので
   * セマンティック寄りに倒すべき、という実測の根拠になる。 */
  function contentWordCount(text) {
    if (!text) return 0;
    var seen = new Set();
    var m = String(text)
      .toLowerCase()
      .match(/[a-z][a-z0-9-]{2,}/g);
    (m || []).forEach((w) => {
      w = w.replace(/[^a-z]/g, "");
      if (w.length > 3 && !STOPWORDS.has(w)) seen.add(w);
    });
    return seen.size;
  }

  /* 語彙スコアとセマンティックスコアの合成に使う語彙重み。
   * 英語: クエリの内容語数で適応（実測: 短いクエリは語彙が疎なのでセマンティック寄り 0.25、
   *   中〜長は 0.4。いずれも従来の 0.5 より上 — EN bench top1 84.4%→グループ別最良で確認）。
   * 日本語: 会議名の日本語チャンク一致が識別力の主役なので語彙寄り 0.6（JP ベンチ A/B）。
   * len: クエリの内容語数（英語のみ。日本語は isJp が優先）。
   */
  function vocabWeight(len, isJp) {
    if (isJp) return 0.6;
    return len !== undefined && len <= 4 ? 0.25 : 0.4;
  }

  /* 語彙スコアとセマンティックスコアの合成。
   * opts: { jp?: boolean, jpw?: number, len?: number } — jpw 指定時は最優先
   * （ベンチマークのスイープ用）、無ければ len と jp から vocabWeight で決める。
   * セマンティックが未ロード（オフライン等）なら語彙スコアをそのまま返す。
   */
  function blendScore(vocab, sem, opts) {
    if (!sem) return vocab;
    var w =
      opts && typeof opts.jpw === "number"
        ? opts.jpw
        : vocabWeight(opts && opts.len, opts && opts.jp);
    return Math.round(vocab * w + sem * (1 - w));
  }

  /* テキストに日本語（かな・漢字）が含まれるか。
   * 言語適応型モデル選択の判定に使う（日本語論文は多言語モデルで埋め込む）。
   */
  function hasJapanese(text) {
    return /[\u3040-\u9fff]/.test(String(text || ""));
  }

  /* 日本語キーワード → 英語の展開（語彙スコア用）。
   * 多言語モデルは日本語論文を埋め込めるが、語彙スコア（会議名の英単語との一致）は
   * 日本語テキストには全く効かない。そこで日本語の分野語を英語に展開してから
   * 分野シグナル・会議名・タグの一致判定に使う（例: 「低遅延」→ latency real-time）。
   * ブラウザの表示テキストや埋め込み入力は変更しない（語彙一致の内部処理のみ）。
   */
  var JP_EN = {
    // システム・分散
    分散処理: "distributed processing",
    分散システム: "distributed system",
    分散: "distributed",
    低遅延: "low latency latency",
    リアルタイム: "real-time realtime",
    組み込み: "embedded",
    カーネル: "kernel",
    オペレーティングシステム: "operating system",
    仮想化: "virtualization",
    スケジューリング: "scheduling",
    スケジューラ: "scheduler",
    ミドルウェア: "middleware",
    ストレージ: "storage",
    メモリ: "memory",
    キャッシュ: "cache",
    コンパイラ: "compiler",
    プロセッサ: "processor",
    マイクロアーキテクチャ: "microarchitecture",
    フォールトトレラント: "fault tolerant",
    高信頼: "reliable dependable",
    データセンター: "data center",
    サーバレス: "serverless",
    コンテナ: "container",
    マイクロサービス: "microservice",
    // ネットワーク
    ネットワーク: "network networking",
    通信: "communication",
    無線: "wireless",
    ルーティング: "routing",
    パケット: "packet",
    エッジコンピューティング: "edge computing",
    エッジ: "edge",
    クラウド: "cloud",
    インターネット: "internet",
    モバイル: "mobile",
    IoT: "iot internet of things",
    // AI・データ
    機械学習: "machine learning",
    深層学習: "deep learning",
    強化学習: "reinforcement learning",
    学習: "learning",
    ニューラルネットワーク: "neural network",
    ニューラル: "neural",
    大規模言語モデル: "large language model",
    生成: "generative generation",
    推論: "inference",
    異常検知: "anomaly detection",
    時系列: "time series",
    データマイニング: "data mining",
    データベース: "database",
    検索: "search retrieval",
    推薦: "recommendation",
    自然言語処理: "natural language processing",
    音声認識: "speech recognition",
    物体検出: "object detection",
    セグメンテーション: "segmentation",
    ブロックチェーン: "blockchain",
    フェデレーテッド: "federated",
    量子: "quantum",
    グラフ: "graph",
    アルゴリズム: "algorithm",
    シミュレーション: "simulation",
    // セキュリティ
    セキュリティ: "security",
    プライバシー: "privacy",
    暗号: "cryptography encryption",
    認証: "authentication",
    攻撃: "attack",
    脆弱性: "vulnerability",
    エンクレーブ: "enclave",
    マルウェア: "malware",
    // 画像・HCI・その他
    画像: "image",
    音声: "speech audio",
    映像: "video multimedia",
    ビジョン: "vision",
    可視化: "visualization",
    レンダリング: "rendering",
    アニメーション: "animation",
    ユーザビリティ: "usability",
    人間: "human",
    拡張現実: "augmented reality",
    仮想現実: "virtual reality",
    センサ: "sensor",
    ロボット: "robot robotics",
    自動運転: "autonomous driving",
    車載: "automotive",
    医療: "medical healthcare",
    交通: "transportation traffic",
    電力: "power energy",
    並列: "parallel",
    ハイパフォーマンス: "high performance hpc",
    スーパーコンピュータ: "supercomputer",
    高性能: "high performance",
    輻輳制御: "congestion control",
    耐故障性: "fault tolerance",
    レプリケーション: "replication",
    コンセンサス: "consensus",
    省電力: "power efficiency energy saving",
    集団通信: "collective communication",
    資源配分: "resource allocation",
    遅延: "latency delay",
    帯域: "bandwidth",
    スループット: "throughput",
    体感品質: "quality of experience qoe",
    負荷分散: "load balancing",
    オーケストレーション: "orchestration",
    プロビジョニング: "provisioning",
    自動化: "automation",
    運用管理: "operations management",
    トラフィック: "traffic",
    スライシング: "slicing",
    仮想マシン: "virtual machine",
    分散共有: "distributed shared",
  };

  /* 語彙一致に使う日本語→英語展開を有効/無効にする（ベンチマークの A/B 用。
   * 実測: 会議名チャンクの合成クエリでは誤爆するが、実論文の日本語語彙では有効）。 */
  var expandEnabled = true;
  function setExpandEnabled(v) {
    expandEnabled = !!v;
  }

  /* 日本語テキストに含まれる分野語を英語に展開する（無ければ ""）。 */
  function expandJp(text) {
    if (!expandEnabled) return "";
    var t = String(text || "").toLowerCase();
    var out = "";
    Object.keys(JP_EN).forEach((jp) => {
      if (t.indexOf(jp.toLowerCase()) !== -1) out += " " + JP_EN[jp];
    });
    return out.trim();
  }

  /* 論文テキスト（全行連結）を埋め込み用の単一クエリ文にする。
   * 先頭行は「自分の投稿予定論文」とみなし 2 回含めて強調する
   * （参考論文のノイズに自分の論文が埋没しないように）。
   */
  function queryText(lines) {
    var all = (lines || []).map((p) =>
      ((p.title || "") + " " + (p.keywords || "")).replace(/\s+/g, " ").trim(),
    );
    var joined = all.filter(Boolean).join(" ").trim();
    var primary = all[0] ? all[0] : "";
    return (primary ? primary + " " : "") + joined;
  }

  function safeExternalUrl(value) {
    var text = String(value == null ? "" : value).trim();
    if (!text) return "";
    try {
      var url = new URL(text, "https://kamiyobi.invalid/");
      return url.protocol === "http:" || url.protocol === "https:" ? text : "";
    } catch (_error) {
      return "";
    }
  }

  var api = {
    DOMAIN_SIGNAL: DOMAIN_SIGNAL,
    STOPWORDS: STOPWORDS,
    parsePaperLines: parsePaperLines,
    autoDetectCats: autoDetectCats,
    venueCategories: venueCategories,
    scorePapers: scorePapers,
    breakdown: breakdown,
    journalRows: journalRows,
    rankMatches: rankMatches,
    pastRepresentatives: pastRepresentatives,
    pickRepresentative: pickRepresentative,
    comparePapers: comparePapers,
    safeExternalUrl: safeExternalUrl,
    matchVenueTag: matchVenueTag,
    blendVectors: blendVectors,
    cosine: cosine,
    semanticScore: semanticScore,
    blendScore: blendScore,
    vocabWeight: vocabWeight,
    contentWordCount: contentWordCount,
    englishRatio: englishRatio,
    setNameIdf: setNameIdf,
    setPaperVecs: setPaperVecs,
    buildNameIdf: buildNameIdf,
    setSigWeights: setSigWeights,
    GENERIC_PAPER_WORDS: GENERIC_PAPER_WORDS,
    hasJapanese: hasJapanese,
    expandJp: expandJp,
    setExpandEnabled: setExpandEnabled,
    queryText: queryText,
    wordInText: wordInText,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.Recommender = api;
})(typeof window !== "undefined" ? window : globalThis);
