/**
 * 推薦品質ベンチマーク（dev tool）
 *
 * 各会議のトピック（カテゴリ正式名の内容語 + タグ + full_name の内容語）から
 * 合成論文クエリを作り、その会議が全会議の中で top-K に入るかを計測する。
 * スコアリングは本番と同じコードパス（site/recommender.js の breakdown +
 * semanticScore + blendScore）を使うため、スコア改変の回帰検出に使える。
 *
 * 使い方:
 *   npm run bench                          # 英語: public/data.json + public/embeddings.json
 *   npm run bench -- --samples 100         # ランダム 100 件に絞る（高速確認）
 *   npm run bench -- --failures 10         # 正解が top-K 外だった事例を表示
 *   npm run bench -- --lang jp             # 日本語（日本語名の会議のみ、多言語モデル）
 *   npm run bench -- --lang jp --jpw 0.35  # 日本語の語彙重みを 0.35 に（既定 0.5）
 *   npm run bench -- --sw name=25,venue=0  # サブシグナル点数を上書き（実測スイープ用）
 *   npm run bench -- --sw nameOnce         # 会議名一致を先頭 1 語の固定加点のみに
 *   npm run bench -- --golden-en           # 実採択論文タイトル（DBLP 由来）で真の精度を測定
 *   npm run bench -- --no-idf              # IDF 減衰を無効化（既定は本番と同じく有効）
 */

import { readFileSync } from "node:fs";
import { type FeatureExtractionPipeline, pipeline } from "@huggingface/transformers";
import { EMBEDDING_MODEL, EMBEDDING_MULTI_MODEL, VENUE_PAPERS } from "./embeddings.ts";

// recommender.js は UMD で、package type:module の下では module.exports が無いため
// globalThis.Recommender に露出する（サイドエフェクト import でロード）。
// @ts-expect-error - no declaration file for plain-JS recommender.js
await import("../site/recommender.js");
const Recommender = (globalThis as { Recommender?: unknown }).Recommender as any;

const STOP = Recommender.STOPWORDS as Set<string>;
const GEN_PAPER = (Recommender.GENERIC_PAPER_WORDS ?? new Set<string>()) as Set<string>;

function parseArgs(argv: string[]): {
  data: string;
  emb: string;
  samples: number;
  failures: number;
  topK: number;
  lang: "en" | "jp";
  jpw: number;
  byLen: boolean;
  adaptive: boolean;
  wGiven: boolean;
  penalty: boolean;
  prf: boolean;
  idf: boolean;
  sw: string | null;
  goldenEn: boolean;
  paperMax: boolean;
} {
  const args: {
    data: string;
    emb: string;
    samples: number;
    failures: number;
    topK: number;
    lang: "en" | "jp";
    jpw: number;
    byLen: boolean;
    adaptive: boolean;
    wGiven: boolean;
    penalty: boolean;
    prf: boolean;
    idf: boolean;
    sw: string | null;
    goldenEn: boolean;
    paperMax: boolean;
  } = {
    data: "public/data.json",
    emb: "public/embeddings.json",
    samples: 0,
    failures: 0,
    topK: 5,
    lang: "en",
    jpw: 0.5,
    byLen: false,
    adaptive: false,
    wGiven: false,
    penalty: false,
    prf: false,
    // IDF は本番（ブラウザの buildNameIdf）と同じく既定オン。--no-idf でオフ
    idf: true,
    sw: null,
    goldenEn: false,
    // R16: usenix-security の論文個別ベクトルを semanticScore の max 類似度に使う
    // （英語のみ）。実測で golden EN top1 15.8→26.3 / top5 63.2→71.9。既定オン。
    paperMax: true,
  };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--data") args.data = rest[++i] ?? args.data;
    else if (a === "--emb") args.emb = rest[++i] ?? args.emb;
    else if (a === "--samples") args.samples = Number(rest[++i]) || 0;
    else if (a === "--failures") args.failures = Number(rest[++i]) || 0;
    else if (a === "--topk") args.topK = Number(rest[++i]) || 5;
    else if (a === "--lang") {
      const v = rest[++i];
      if (v === "jp") args.lang = "jp";
    } else if (a === "--jpw" || a === "--w") {
      args.jpw = Number(rest[++i]) || 0.5;
      args.wGiven = true;
    } else if (a === "--by-len") args.byLen = true;
    else if (a === "--adaptive") args.adaptive = true;
    else if (a === "--penalty") args.penalty = true;
    else if (a === "--prf") args.prf = true;
    else if (a === "--idf") args.idf = true;
    else if (a === "--no-idf") args.idf = false;
    else if (a === "--golden-en") args.goldenEn = true;
    else if (a === "--paper-max") args.paperMax = true;
    else if (a === "--no-paper-max") args.paperMax = false;
    else if (a === "--sw") {
      args.sw = rest[++i] ?? null;
      // 例: "name=25,venue=80,domain=0,tags=0" または "nameOnce"（会議名一致を先頭 1 語のみ）
      for (const kv of (args.sw || "").split(",")) {
        const [k, v] = kv.split("=");
        if (!k) continue;
        if (k === "nameOnce") {
          Recommender.setSigWeights({ nameOnce: true });
        } else if (v !== undefined) {
          const n = Number(v);
          if (!Number.isNaN(n)) {
            const key = k as "domain" | "name" | "jp" | "tags" | "venue";
            Recommender.setSigWeights({ [key]: n });
          }
        }
      }
    }
  }
  return args;
}

interface Conf {
  key: string;
  title: string;
  full_name: string;
  categories: string[];
  tags: string[];
}

/** ベンチのクエリ単位（合成・golden で形状が異なる） */
interface BenchQuery {
  key: string;
  tw: string[];
  conf?: Conf;
  qid?: string;
  golden?: boolean;
}

function norm(s: string): string {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function contentWords(s: string): string[] {
  return norm(s)
    .split(" ")
    .filter((w) => w.length > 3 && !STOP.has(w));
}

/** メタデータタグ（本文語彙として検索されない属性語）。R11 でスコアリング側の
 * GENERIC_TAGS 除外と対にした — 合成クエリが workshop/journal を含むと、
 * 自己マッチの +10 で「除外がマイナス」という artifact が出るため、クエリ側も除く。 */
const GENERIC_TAGS = new Set([
  "niche",
  "workshop",
  "domestic-jp",
  "journal",
  "special-issue",
  "niche-jp",
]);

/** 会議のトピック語（実論文が使う語彙を模す）: トピックタグ + カテゴリ正式名の内容語 + full_name の内容語 */
function topicWords(c: Conf, catFull: Record<string, string>): string[] {
  const words: string[] = [];
  const seen = new Set<string>();
  const add = (w: string): void => {
    w = w.toLowerCase();
    if (w.length > 3 && !STOP.has(w) && !seen.has(w)) {
      seen.add(w);
      words.push(w);
    }
  };
  (c.tags ?? []).filter((t) => !GENERIC_TAGS.has(t)).forEach(add);
  (c.categories ?? []).forEach((k) => {
    contentWords(catFull[k] ?? k).forEach(add);
  });
  contentWords(c.full_name ?? c.title ?? "")
    .slice(0, 6)
    .forEach(add);
  return words.slice(0, 10);
}

/** 会議名に現れる汎用的な日本語（どの会議にも出る）は、日本語クエリの識別語にしない */
const JP_STOP = new Set([
  "情報処理学会",
  "電子情報通信学会",
  "研究会",
  "特集号",
  "シンポジウム",
  "論文誌",
  "学会",
  "信学技報",
  "電子情報通信", // IEEE 相当の組織プレフィックス
  "情報処理", // IPSJ 相当（全 IPSJ 会議に出る）
]);

/** 実ユーザーが入力しそうな日本語論文（タイトル + キーワード）→ 正解会議。
 * 正解は「そのトピックで最も自然な投稿先」。国内研究会は対応する国際会議が無い
 * トピックなので曖昧性が低い。国際会議は分野が明確なものだけ採用する。
 * キーワードは日英混在（実ユーザーの入力パターン）と日本語のみの両方を含む。 */
const GOLDEN_JP: Array<{ title: string; keywords: string; key: string }> = [
  // 分散・並列処理（DPS 研）
  {
    title: "分散システムにおける複製管理とコンセンサスプロトコルの設計",
    keywords: "分散処理, レプリケーション, コンセンサス, 耐故障性",
    key: "ipsj-sigdps",
  },
  {
    title: "モバイルエッジ環境向け低遅延ミドルウェアの実装と評価",
    keywords: "エッジ, 低遅延, ミドルウェア",
    key: "ipsj-sigdps",
  },
  // OS（OS 研）
  {
    title: "Linux カーネル向け省電力スケジューラの実装と評価",
    keywords: "カーネル, スケジューリング, 省電力",
    key: "ipsj-sigos",
  },
  {
    title: "コンテナ環境におけるメモリ管理のオーバーヘッド解析",
    keywords: "コンテナ, メモリ, 仮想化",
    key: "ipsj-sigos",
  },
  // HPC（HPC 研）
  {
    title: "GPU クラスタ向け集団通信ライブラリの性能最適化",
    keywords: "GPU, 並列, 集団通信, MPI",
    key: "ipsj-sighpc",
  },
  {
    title: "大規模数値シミュレーションの通信特性の解析",
    keywords: "スーパーコンピュータ, 並列, シミュレーション",
    key: "ipsj-sighpc",
  },
  // ネットワーク（NS/IN 研）
  {
    title: "サービスメッシュにおけるトラフィック制御の検証",
    keywords: "ネットワーク, トラフィック, SDN",
    key: "ieice-ns",
  },
  {
    title: "5G コアネットワークにおけるスライシング資源配分",
    keywords: "ネットワーク, スライシング, 資源配分",
    key: "ieice-in",
  },
  // 通信品質（CQ 研）
  {
    title: "ウェブサービスにおけるユーザ体感品質の測定手法",
    keywords: "通信品質, 体感品質, 遅延",
    key: "ieice-cq",
  },
  {
    title: "車載ネットワークにおけるリアルタイム通信の品質評価",
    keywords: "通信, 品質, 車載",
    key: "ieice-cq",
  },
  // コンピュータシステム（ComSys）
  {
    title: "自律分散コンピュータシステムの構成管理手法",
    keywords: "分散システム, 構成管理, 自律",
    key: "comsys",
  },
  // アーキテクチャ（ARC 研）
  {
    title: "キャッシュコヒーレンシのためのマイクロアーキテクチャ設計",
    keywords: "キャッシュ, コヒーレンシ, アーキテクチャ",
    key: "ipsj-sigarc",
  },
  // 通信マネジメント（ICM 研）
  {
    title: "エッジコンピューティング基盤の運用管理の自動化",
    keywords: "エッジ, 運用管理, 自動化",
    key: "ieice-icm",
  },
  // IPSJ 特集号
  {
    title: "超知能と社会システムの共進化に関する考察",
    keywords: "超知能, 社会システム, AI",
    key: "ipsj-27-l-superintelligence",
  },
  {
    title: "AI 時代の社会基盤を支えるコンピュータセキュリティ技術",
    keywords: "セキュリティ, 社会基盤, コンピュータセキュリティ",
    key: "ipsj-27-m-security",
  },
  // 国際会議（分野が明確なもの）
  {
    title: "NVMe SSD 向けログ構造化ストレージの設計と実装",
    keywords: "nvme, ssd, log-structured, storage",
    key: "fast",
  },
  {
    title: "リアルタイムシステムにおける分散共有資源のスケジューリング",
    keywords: "real-time, scheduling, resource",
    key: "rtss",
  },
  {
    title: "SGX エンクレーブにおける機械学習推論の保護",
    keywords: "sgx, enclave, machine learning, privacy",
    key: "s-p",
  },
  {
    title: "データセンターネットワークにおける輻輳制御の設計",
    keywords: "datacenter, congestion control, network",
    key: "nsdi",
  },
  // 国内: 電子情報通信学会 特集号・その他研究会
  {
    title: "ミリ波帯無線フロントエンド向けマイクロ波回路の設計",
    keywords: "マイクロ波, ミリ波, 無線, 回路",
    key: "ieice-electron-microwave-special",
  },
  {
    title: "グラフ彩色数とその応用に関する離散数学的考察",
    keywords: "離散数学, グラフ, 彩色, 応用",
    key: "ieice-fundamentals-discrete-math-special",
  },
  {
    title: "オフィス情報システムにおけるログデータ活用の基盤技術",
    keywords: "ログデータ, 活用技術, オフィス情報",
    key: "ieice-inf-syst-log-data-special",
  },
  {
    title: "非線形力学系のカオス解析とその工学応用",
    keywords: "非線形理論, カオス, 力学系, 応用",
    key: "ieice-nolta-recent-advances-special",
  },
  {
    title: "大規模ネットワークの経路制御プロトコルの評価手法",
    keywords: "ネットワーク, 経路制御, プロトコル, 評価",
    key: "ieice-in",
  },
  // 国内: 情報処理学会 論文誌特集号・大会
  {
    title: "情報システムの要件定義プロセスの改善手法",
    keywords: "情報システム, 要件定義, プロセス",
    key: "ipsj-27-n-info-systems",
  },
  {
    title: "ユビキタス環境におけるコンテキスト認識基盤の設計",
    keywords: "ユビキタス, コンテキスト, 認識, 基盤",
    key: "ipsj-27-p-ubiquitous",
  },
  {
    title: "Web アプリケーションのアクセシビリティ評価フレームワーク",
    keywords: "Web, アプリケーション, アクセシビリティ, 評価",
    key: "ipsj-27-r-compsac",
  },
  {
    title: "情報処理分野における近年の研究動向のサーベイ",
    keywords: "サーベイ, 情報処理, 研究動向",
    key: "jip",
  },
  {
    title: "情報科学技術フォーラムにおけるセッション報告と考察",
    keywords: "情報科学技術, フォーラム, セッション",
    key: "fit",
  },
  {
    title: "インターネットサービスの運用自動化と障害対応の実践",
    keywords: "インターネット, 運用技術, 自動化, 障害対応",
    key: "iots",
  },
  // 国内: 既存研究会の別トピック
  {
    title: "リアルタイム OS のメモリ保護機構の実装と評価",
    keywords: "リアルタイム, OS, メモリ保護, カーネル",
    key: "ipsj-sigos",
  },
  {
    title: "分散システムにおけるコンセンサスアルゴリズムの実装比較",
    keywords: "分散システム, コンセンサス, 実装, 比較",
    key: "comsys",
  },
  {
    title: "低遅延ストリーミングにおける体感品質と通信品質の相関分析",
    keywords: "低遅延, ストリーミング, 体感品質, 通信品質",
    key: "ieice-cq",
  },
  // 国際: 分野が明確な追加
  {
    title: "NVMe オーバーファブリックにおける RDMA 転送の性能解析",
    keywords: "nvme, rdma, fabric, storage",
    key: "fast",
  },
  {
    title: "Time-Sensitive Networking のスケジューラ実装と評価",
    keywords: "tsn, scheduling, real-time, ethernet",
    key: "rtss",
  },
];

/** golden EN（実採択論文タイトル、タイトルのみで測定）: 合成クエリは会議名の内容語から
 * 作るため実論文より易しい。こちらは会議名チャンクを含まない実際の論文タイトルで
 * 真の精度を測る（R12 追加）。出典: USENIX NSDI/OSDI '25 technical sessions、
 * SOSP '25 accepted (sigops.org)、NDSS '25 accepted、ICML (PMLR v162)。 */
const GOLDEN_EN: Array<{ title: string; key: string }> = [
  // NSDI '25
  {
    title:
      "PRED: Performance-oriented Random Early Detection for Consistently Stable Performance in Datacenters",
    key: "nsdi",
  },
  {
    title: "Minder: Faulty Machine Detection for Large-scale Distributed Model Training",
    key: "nsdi",
  },
  {
    title:
      "AutoCCL: Automated Collective Communication Tuning for Accelerating Distributed and Parallel DNN Training",
    key: "nsdi",
  },
  {
    title:
      "Beehive: A Scalable Disaggregated Memory Runtime Exploiting Asynchrony of Multithreaded Programs",
    key: "nsdi",
  },
  {
    title:
      "One-Size-Fits-None: Understanding and Enhancing Slow Fault Tolerance in Modern Distributed Systems",
    key: "nsdi",
  },
  {
    title: "GREEN: Carbon-efficient Resource Scheduling for Machine Learning Clusters",
    key: "nsdi",
  },
  // OSDI '25
  {
    title:
      "QiMeng-Xpiler: Transcompiling Tensor Programs for Deep Learning Systems with a Neural-Symbolic Approach",
    key: "osdi",
  },
  {
    title: "WLB-LLM: Workload-Balanced 4D Parallelism for Large Language Model Training",
    key: "osdi",
  },
  {
    title: "NanoFlow: Towards Optimal Large Language Model Serving Throughput",
    key: "osdi",
  },
  {
    title: "Mirage: A Multi-Level Superoptimizer for Tensor Programs",
    key: "osdi",
  },
  {
    title: "WaferLLM: Large Language Model Inference at Wafer Scale",
    key: "osdi",
  },
  {
    title: "Quake: Adaptive Indexing for Vector Search",
    key: "osdi",
  },
  // SOSP '25
  { title: "Rearchitecting the Thread Model of In-Memory Key-Value Stores", key: "sosp" },
  { title: "Device-Assisted Live Migration of RDMA Devices", key: "sosp" },
  {
    title:
      "Mercury: Unlocking Multi-GPU Operator Optimization for LLMs via Remote Memory Scheduling",
    key: "sosp",
  },
  {
    title:
      "Demeter: A Scalable and Elastic Tiered Memory Solution for Virtualized Cloud via Guest Delegation",
    key: "sosp",
  },
  { title: "Sleeping with One Eye Open: Fast, Sustainable Storage with Sandman", key: "sosp" },
  { title: "LithOS: An Operating System for Efficient Machine Learning on GPUs", key: "sosp" },
  { title: "Scalable Far Memory: Balancing Faults and Evictions", key: "sosp" },
  {
    title: "Tiga: Accelerating Geo-Distributed Transactions with Synchronized Clocks",
    key: "sosp",
  },
  { title: "eBPF Misbehavior Detection: Fuzzing with a Specification-Based Oracle", key: "sosp" },
  { title: "FlexGuard: Fast Mutual Exclusion Independent of Subscription", key: "sosp" },
  // NDSS '25
  { title: "A Comprehensive Memory Safety Analysis of Bootloaders", key: "ndss" },
  { title: "A Systematic Evaluation of Novel and Existing Cache Side Channels", key: "ndss" },
  { title: "CounterSEVeillance: Performance-Counter Attacks on AMD SEV-SNP", key: "ndss" },
  { title: "Alba: The Dawn of Scalable Bridges for Blockchains", key: "ndss" },
  {
    title: "BULKHEAD: Secure, Scalable, and Efficient Kernel Compartmentalization with PKS",
    key: "ndss",
  },
  {
    title: "Black-box Membership Inference Attacks against Fine-tuned Diffusion Models",
    key: "ndss",
  },
  { title: "Automatic Library Fuzzing through API Relation Evolvement", key: "ndss" },
  // ICML (PMLR v162)
  { title: "PAC-Bayesian Bounds on Rate-Efficient Classifiers", key: "icml" },
  { title: "Batched Dueling Bandits", key: "icml" },
  {
    title: "Deep Equilibrium Networks are Sensitive to Initialization Statistics",
    key: "icml",
  },
  {
    title: "Private Optimization in the Interpolation Regime: Faster Rates and Hardness Results",
    key: "icml",
  },
  {
    title:
      "data2vec: A General Framework for Self-supervised Learning in Speech, Vision and Language",
    key: "icml",
  },
  // RTSS '25（2025.rtss.org program）
  {
    title:
      "HCInfer: Hierarchical Coordination for Real-Time Collaborative Inference of LLM on the Edge",
    key: "rtss",
  },
  {
    title:
      "CoEdge-RAG: Optimizing Hierarchical Scheduling for Retrieval-Augmented LLMs in Collaborative Edge Computing",
    key: "rtss",
  },
  {
    title: "CF-DETR: Coarse-to-Fine Transformer for Real-Time Object Detection",
    key: "rtss",
  },
  {
    title:
      "WatwaOS: A Framework for Worst-Case-Aware Tailoring and Whole-System Analysis of Energy-Constrained Real-Time Systems",
    key: "rtss",
  },
  {
    title: "CARTEL: Consensus Adapting Real-Time and Efficient Logging",
    key: "rtss",
  },
  {
    title: "FALCON: FPGA Accelerated Real-Time Intelligent Controller for Autonomous Systems",
    key: "rtss",
  },
  {
    title:
      "Stability-Guaranteed Scheduling for Mesh Networked Control Systems with Fine-Grained Timing",
    key: "rtss",
  },
  {
    title: "Timely Classification of Hierarchical Classes",
    key: "rtss",
  },
  // ECRTS '25（DROPS LIPIcs vol.335）
  {
    title: "A Multi-UAV Router and Scheduler for Executing Spatially Scattered Real-Time Tasks",
    key: "ecrts",
  },
  {
    title: "Sensor Fusion Desynchronization Attacks",
    key: "ecrts",
  },
  {
    title:
      "Period Assignment for Real-Time Cascade Control Tasks Under Stability and Schedulability Constraints",
    key: "ecrts",
  },
  // USENIX Security '25（arXiv コメントで採択確認。VENUE_PAPERS の 24 本と完全分離）
  {
    title:
      "Exploring and Exploiting the Resource Isolation Attack Surface of WebAssembly Containers",
    key: "usenix-security",
  },
  {
    title: "Depth Gives a False Sense of Privacy: LLM Internal States Inversion",
    key: "usenix-security",
  },
  {
    title: "SoK: Automated Vulnerability Repair: Methods, Tools, and Assessments",
    key: "usenix-security",
  },
  { title: "Oblivious Digital Tokens", key: "usenix-security" },
  {
    title: "URL Inspection Tasks: Helping Users Detect Phishing Links in Emails",
    key: "usenix-security",
  },
  {
    title:
      "Towards Label-Only Membership Inference Attack against Pre-trained Large Language Models",
    key: "usenix-security",
  },
  {
    title:
      "I Can Tell Your Secrets: Inferring Privacy Attributes from Mini-app Interaction History in Super-apps",
    key: "usenix-security",
  },
  {
    title: "DarkGram: A Large-Scale Analysis of Cybercriminal Activity Channels on Telegram",
    key: "usenix-security",
  },
  {
    title: "Deanonymizing Ethereum Validators: The P2P Network Has a Privacy Issue",
    key: "usenix-security",
  },
  {
    title: "SafeSpeech: Robust and Universal Voice Protection Against Malicious Speech Synthesis",
    key: "usenix-security",
  },
  {
    title: "Great, Now Write an Article About That: The Crescendo Multi-Turn LLM Jailbreak Attack",
    key: "usenix-security",
  },
  {
    title: "SelfDefend: LLMs Can Defend Themselves against Jailbreaking in a Practical Manner",
    key: "usenix-security",
  },
  // ICDCS '25（icdcs2025.icdcs.org/accepted-papers メイントラック。VENUE_PAPERS と完全分離）
  {
    title: "InverCRS: Generative Audio Inversion Attack in Collaborative Recognition Systems",
    key: "icdcs",
  },
  {
    title: "BEyes: Unseen Eyes Snooping Pattern Lock via BFI",
    key: "icdcs",
  },
  {
    title:
      "Uncovering Hidden Proxy Smart Contracts for Finding Collision Vulnerabilities in Ethereum",
    key: "icdcs",
  },
  {
    title: "Physical Backdoor Attacks against mmWave-based Human Activity Recognition",
    key: "icdcs",
  },
  {
    title: "A Lightweight Secure Aggregation Protocol for Federated Learning Applications",
    key: "icdcs",
  },
  {
    title: "SGX-Enabled Encrypted Cross-Cloud Data Synchronization",
    key: "icdcs",
  },
  {
    title: "Shared memory consensus on a ring: Epigenetic Consensus",
    key: "icdcs",
  },
  // CHES '25 = TCHES 2025 Issue 1-4（ches.iacr.org/2025/acceptedpapers.php。VENUE_PAPERS と完全分離）
  {
    title:
      "Blind-Folded: Simple Power Analysis Attacks using Data with a Single Trace and no Training",
    key: "ches",
  },
  {
    title: "Leaky McEliece: Secret Key Recovery From Highly Erroneous Side-Channel Information",
    key: "ches",
  },
  {
    title: "Shortcut2Secrets: A Table-based Differential Fault Attack Framework",
    key: "ches",
  },
  {
    title: "VeloFHE: GPU Acceleration for FHEW and TFHE Bootstrapping",
    key: "ches",
  },
  {
    title:
      "Rejected Signatures' Challenges Pose New Challenges: Key Recovery of CRYSTALS-Dilithium via Side-Channel Attacks",
    key: "ches",
  },
  {
    title: "HIPR: Hardware IP Protection through Low-Overhead Fine-Grain Redaction",
    key: "ches",
  },
  // RTAS '25（dblp rtas2025 フルペーパー。VENUE_PAPERS と完全分離）
  {
    title:
      "Cros-Rt: Cross-Layer Priority Scheduling for Predictable Inter-Process Communication in Ros 2",
    key: "rtas",
  },
  {
    title:
      "Physics-Informed Mixed-Criticality Scheduling for F1Tenth Cars with Preemptable ROS 2 Executors",
    key: "rtas",
  },
  {
    title:
      "Handling System Overloads: An Empirical Evaluation of Deadline-Miss Handling Strategies",
    key: "rtas",
  },
  {
    title: "Arm Dynamiq Shared Unit and Real-Time: An Empirical Evaluation",
    key: "rtas",
  },
  {
    title: "LiME: The Linux Real-Time Task Model Extractor",
    key: "rtas",
  },
  {
    title:
      "ConvolutionalFixedSum: Uniformly Generating Random Values with a Fixed Sum Subject to Arbitrary Constraints",
    key: "rtas",
  },
  {
    title: "A Design Flow to Securely Isolate FPGA Bus Transactions in Heterogeneous SoCs",
    key: "rtas",
  },
  {
    title: "Janus: OS Support for a Secure, Fast Control-Plane",
    key: "rtas",
  },
  // EuroSys '25（dblp eurosys2025、85 本。VENUE_PAPERS に eurosys は無い = リークなし）
  {
    title:
      "eNetSTL: Towards an In-kernel Library for High-Performance eBPF-based Network Functions",
    key: "eurosys",
  },
  {
    title: "Achilles: Efficient TEE-Assisted BFT Consensus via Rollback Resilient Recovery",
    key: "eurosys",
  },
  {
    title: "SkyServe: Serving AI Models across Regions and Clouds with Spot Instances",
    key: "eurosys",
  },
  {
    title:
      "Themis: Finding Imbalance Failures in Distributed File Systems via a Load Variance Model",
    key: "eurosys",
  },
  {
    title: "Fast State Restoration in LLM Serving with HCache",
    key: "eurosys",
  },
  {
    title: "Revealing the Unstable Foundations of eBPF-Based Kernel Extensions",
    key: "eurosys",
  },
  {
    title: "RoboRebound: Multi-Robot System Defense with Bounded-Time Interaction",
    key: "eurosys",
  },
  // PPoPP '25（dblp ppopp2025、50 本。VENUE_PAPERS と完全分離 = リークなし）
  {
    title:
      "Accelerating GNNs on GPU Sparse Tensor Cores through N: M Sparsity-Oriented Graph Reordering",
    key: "ppopp",
  },
  {
    title: "Adaptive Parallel Training for Graph Neural Networks",
    key: "ppopp",
  },
  {
    title:
      "TurboFFT: Co-Designed High-Performance and Fault-Tolerant Fast Fourier Transform on GPUs",
    key: "ppopp",
  },
  { title: "Reciprocating Locks", key: "ppopp" },
  { title: "Aggregating Funnels for Faster Fetch&Add and Queues", key: "ppopp" },
  {
    title:
      "Publish on Ping: A Better Way to Publish Reservations in Memory Reclamation for Concurrent Data Structures",
    key: "ppopp",
  },
  {
    title:
      "AC-Cache: A Memory-Efficient Caching System for Small Objects via Exploiting Access Correlations",
    key: "ppopp",
  },
  // SIGCOMM '25（dblp sigcomm2025、88 本。VENUE_PAPERS と完全分離 = リークなし）
  {
    title: "LeoCC: Making Internet Congestion Control Robust to LEO Satellite Dynamics",
    key: "sigcomm",
  },
  { title: "Falcon: A Reliable, Low Latency Hardware Transport", key: "sigcomm" },
  { title: "Inter-domain Routing with Extensible Criteria", key: "sigcomm" },
  {
    title:
      "InfiniteHBD: Building Datacenter-Scale High-Bandwidth Domain for LLM with Optical Circuit Switching Transceivers",
    key: "sigcomm",
  },
  { title: "Revisiting RDMA Reliability for Lossy Fabrics", key: "sigcomm" },
  {
    title: "ByteDance Jakiro: Enabling RDMA and TCP over Virtual Private Cloud",
    key: "sigcomm",
  },
  {
    title: "SGLB: Scalable and Robust Global Load Balancing in Commodity AI Clusters",
    key: "sigcomm",
  },
];

/** 会議名から日本語の内容チャンクを取り出す（実論文が使う日本語語彙を模す）。
 * 助詞（と/の/を 等）で分割し、末尾の汎用語（研究会/システム 等）を落とす。 */
function jpChunks(s: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of String(s ?? "").match(/[\u3000-\u9fff]{2,}/g) ?? []) {
    for (let part of m.split(/[ともの・、／()（）]/)) {
      part = part.replace(
        /(学会|研究会|シンポジウム|特集号|論文誌|大会|フォーラム|技術|報告|システム|コンピュータ|処理)$/,
        "",
      );
      part = part.trim();
      if (part.length < 2 || JP_STOP.has(part) || seen.has(part)) continue;
      // ひらがな主体の文法的断片（例: 「共に革新する」）は捨てる
      if (/[ぁ-ん]{3,}/.test(part) && !/[\u4e00-\u9fff]/.test(part)) continue;
      seen.add(part);
      out.push(part);
    }
  }
  return out.slice(0, 10);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const data = JSON.parse(readFileSync(args.data, "utf8")) as {
    conferences: Conf[];
    categories?: Record<string, string>;
  };
  const emb = JSON.parse(readFileSync(args.emb, "utf8")) as {
    embeddings: Record<string, number[]>;
    multi?: { embeddings: Record<string, number[]> };
    paperVecs?: Record<string, number[][]>;
  };
  const catFull = (data.categories ?? {}) as Record<string, string>;
  const confs = data.conferences;

  const isJp = args.lang === "jp";
  // golden EN モード: 実採択論文タイトル（タイトルのみ）で真の精度を測る。
  // 複数エントリが同じ会議キーを持つため、クエリ識別子（qid）で一意化する。
  const queries: BenchQuery[] = args.goldenEn
    ? GOLDEN_EN.map((g, i) => ({ key: g.key, qid: `g${i}`, tw: [g.title], golden: true }))
    : isJp
      ? confs
          .map((c) => ({ key: c.key, tw: jpChunks(`${c.title} ${c.full_name}`), conf: c }))
          .filter((q) => q.tw.length >= 2)
      : confs
          .map((c) => ({ key: c.key, tw: topicWords(c, catFull), conf: c }))
          .filter((q) => q.tw.length >= 3);
  let selected = queries;
  if (args.samples > 0 && args.samples < selected.length) {
    // 決定論的にサンプリング（seed 固定）して再現可能にする
    const step = Math.floor(selected.length / args.samples);
    selected = selected.filter((_, i) => i % step === 0).slice(0, args.samples);
  }
  const model = isJp ? EMBEDDING_MULTI_MODEL : EMBEDDING_MODEL;
  const venueEmb = isJp ? (emb.multi?.embeddings ?? emb.embeddings) : emb.embeddings;

  // --idf: 会議名 + 代表論文語彙の IDF 重み表（希少語ほど重い）。
  // 代表論文語彙は汎用語（machine/deep/cache 等）が全会議に出現しやすく、
  // そのまま語彙一致に使うと会議間で衝突する（R12 実測）ため、df で汎用語を減衰する。
  // R14 実測で 2 マップ化: (1) 名前と papers の混在 df だと papers 追加（rtss/ecrts）で
  // 名前語の IDF が薄まり合成 top1 84.8→76.9 に悪化、(2) 名前優先 1 マップだと
  // 名前にも出る語（memory 等）が papers マッチでも高重みになり rtss/ecrts の papers
  // 語彙が無関係クエリを奪う。マッチ元ごとに別マップを使う。buildNameIdf
  // （recommender.js）と同じ定義。
  if (args.idf) {
    const nameDf = new Map<string, number>();
    const paperDf = new Map<string, number>();
    const bump = (m: Map<string, number>, w: string): void => {
      m.set(w, (m.get(w) ?? 0) + 1);
    };
    for (const c of confs) {
      const seenName = new Set<string>();
      for (const w of contentWords(`${c.title ?? ""} ${c.full_name ?? ""}`)) {
        if (!seenName.has(w)) {
          seenName.add(w);
          bump(nameDf, w);
        }
      }
      const seenPaper = new Set<string>();
      for (const w of contentWords((VENUE_PAPERS[c.key] ?? []).join(" "))) {
        // paper 語彙の汎用語（self/general/framework 等）はスコアリングで加点されないので df にも数えない（R18）
        if (GEN_PAPER.has(w)) continue;
        if (!seenPaper.has(w)) {
          seenPaper.add(w);
          bump(paperDf, w);
        }
      }
    }
    const N = confs.length;
    const idfOf = (d: number): number => Math.log(1 + N / (d + 1)) / Math.log(1 + N);
    const mk = (m: Map<string, number>): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const [w, d] of m) out[w] = idfOf(d);
      return out;
    };
    Recommender.setNameIdf({ name: mk(nameDf), paper: mk(paperDf) });
  }
  // R16: 英語クエリのみ論文個別ベクトル（max 類似度）を有効化。
  // 日本語クエリは多言語モデルなので英語モデルの論文ベクトルを混ぜない
  // （R12 の言語別分離設計）。
  if (args.paperMax && !isJp && emb.paperVecs) {
    Recommender.setPaperVecs(emb.paperVecs);
  } else {
    Recommender.setPaperVecs(null);
  }
  const scheme = args.wGiven
    ? `score = vocab×${args.jpw} + sem×${(1 - args.jpw).toFixed(2)}`
    : args.goldenEn
      ? "score = adaptive (実論文タイトル, vocab×vocabWeight(len))"
      : isJp
        ? `score = vocab×${args.jpw} + sem×${(1 - args.jpw).toFixed(2)} (日本語: 0.6 固定)`
        : "score = adaptive (vocab×vocabWeight(len), 内容語数で 0.25/0.4)";
  const sigNote = args.sw ? ` sigWeights=[${args.sw}]` : "";
  const pmNote = args.paperMax ? " paperMax=on" : "";
  console.log(
    `bench: ${selected.length} conferences, lang=${args.lang}, model=${model}, topK=${args.topK} (${scheme}${sigNote}${pmNote})`,
  );

  // クエリを埋め込む（embeddings.ts と同じ呼び出し方）
  const embed = async (): Promise<Map<string, number[]>> => {
    const extractor = (await pipeline("feature-extraction", model)) as FeatureExtractionPipeline;
    const out = new Map<string, number[]>();
    const batch = 64;
    for (let i = 0; i < selected.length; i += batch) {
      const texts = selected.slice(i, i + batch).map((q) => q.tw.join(" "));
      const output = await extractor(texts, { pooling: "mean", normalize: true });
      const tensors = Array.isArray(output) ? output : [output];
      let idx = 0;
      for (const tensor of tensors) {
        const n = tensor.dims[0] ?? 1;
        const w = tensor.dims[1] ?? 384;
        const arr = Array.from(tensor.data as Float32Array | ArrayLike<number>);
        for (let j = 0; j < n; j++) {
          out.set(selected[i + idx]!.qid ?? selected[i + idx]!.key, arr.slice(j * w, (j + 1) * w));
          idx++;
        }
      }
    }
    return out;
  };

  // 本番と同じスコアリング: Recommender.breakdown（語彙）+ semanticScore + blendScore
  // 本番と同じスコアリング: Recommender.breakdown（語彙）+ semanticScore + blendScore
  const rowFor = (c: Conf): Record<string, unknown> => ({
    conf: {
      key: c.key,
      title: c.title,
      full_name: c.full_name,
      tags: c.tags ?? [],
      // 代表論文語彙（embedding 側の VENUE_PAPERS と同じ出典）— 語彙一致にも効かせる。
      // 本番ではデータパイプラインが conferences に papers を載せる想定（未実装なら空 = 従来動作）。
      papers: VENUE_PAPERS[c.key] ?? [],
    },
    cats: c.categories ?? [],
  });
  const lines = (tw: string[], golden?: boolean): unknown[] =>
    golden
      ? [{ title: tw.join(" "), keywords: "", venue: "" }]
      : [{ title: "", keywords: tw.join(" "), venue: "" }];

  const queryVec = await embed();
  const runSynthetic = (
    expand: boolean,
  ): {
    hits: { top1: number; top5: number; top10: number };
    failures: Array<{ rank: number; key: string; title: string; top: string[] }>;
  } => {
    Recommender.setExpandEnabled(expand);
    const hits = { top1: 0, top5: 0, top10: 0 };
    const failures: Array<{ rank: number; key: string; title: string; top: string[] }> = [];
    for (const q of selected) {
      const scored: Array<[string, number]> = [];
      const qv = queryVec.get(q.qid ?? q.key);
      for (const c of confs) {
        const vocab = Recommender.breakdown(rowFor(c), lines(q.tw, q.golden)).score as number;
        const semRaw = qv ? (Recommender.semanticScore(c.key, qv, venueEmb) as number) : 0;
        // --penalty: 英語クエリで日本語名主体の会議（英語モデルの埋め込みが不正確）を減衰。
        // 研究会（sighpc 等）は英語名で正しく拾えることもあるので、特集号のみ対象にする
        // （IPSJ 特集号は英語テキストが薄くカテゴリ重心に埋まる — 誤マッチの実測元）。
        const isSpecialIssue = (c.tags ?? []).includes("special-issue");
        const sem =
          !isJp && args.penalty && isSpecialIssue
            ? Math.round(semRaw * (Recommender.englishRatio(c) as number))
            : semRaw;
        // 既定は本番と同じ適応（vocabWeight: 内容語数で 0.25/0.4、日本語 0.6）。
        // --w/--jpw 指定時は固定重み（スイープ用）
        const opts = !args.wGiven
          ? { jp: isJp, len: q.golden ? Recommender.contentWordCount(q.tw.join(" ")) : q.tw.length }
          : args.adaptive && !isJp
            ? { len: q.tw.length }
            : { jpw: args.jpw };
        scored.push([c.key, Recommender.blendScore(vocab, sem, opts) as number]);
      }
      scored.sort((a, b) => b[1] - a[1]);
      const rank = scored.findIndex((x) => x[0] === q.key) + 1;
      if (rank <= 1) hits.top1++;
      if (rank <= 5) hits.top5++;
      if (rank <= 10) hits.top10++;
      if (rank > args.topK) {
        failures.push({
          rank,
          key: q.key,
          title: q.golden ? q.tw.join(" ") : (q.conf?.title ?? q.key),
          top: scored.slice(0, 3).map((s) => `${s[0]}(${s[1]}%)`),
        });
      }
    }
    return { hits, failures };
  };
  const synthResults = isJp
    ? [true, false].map((e) => ({ e, ...runSynthetic(e) }))
    : [{ e: true, ...runSynthetic(true) }];
  for (const r of synthResults) {
    const nn = selected.length;
    const s1 = ((r.hits.top1 / nn) * 100).toFixed(1);
    const s5 = ((r.hits.top5 / nn) * 100).toFixed(1);
    const s10 = ((r.hits.top10 / nn) * 100).toFixed(1);
    console.log(
      `top1: ${s1}%  top5: ${s5}%  top10: ${s10}%  (n=${nn}${isJp ? `, expand=${r.e ? "on" : "off"}` : ""})`,
    );
    if (args.byLen && !isJp) {
      // クエリ長（語数）ごとの top1。短いクエリは語彙が疎、長いクエリは語彙が濃い
      const groups: Record<string, { n: number; top1: number }> = {};
      for (const q of selected) {
        const L = q.tw.length <= 4 ? "short(<=4)" : q.tw.length <= 7 ? "mid(5-7)" : "long(>=8)";
        groups[L] ??= { n: 0, top1: 0 };
        groups[L]!.n++;
      }
      // 再スコアして長さグループごとの top1 を集計（expand 状態を揃える）
      Recommender.setExpandEnabled(r.e);
      for (const q of selected) {
        const scored: Array<[string, number]> = [];
        const qv = queryVec.get(q.key);
        for (const c of confs) {
          const vocab = Recommender.breakdown(rowFor(c), lines(q.tw)).score as number;
          const sem = qv ? (Recommender.semanticScore(c.key, qv, venueEmb) as number) : 0;
          scored.push([c.key, Recommender.blendScore(vocab, sem, { jpw: args.jpw }) as number]);
        }
        scored.sort((a, b) => b[1] - a[1]);
        const rank = scored.findIndex((x) => x[0] === q.key) + 1;
        const L = q.tw.length <= 4 ? "short(<=4)" : q.tw.length <= 7 ? "mid(5-7)" : "long(>=8)";
        if (rank <= 1) groups[L]!.top1++;
      }
      for (const L of ["short(<=4)", "mid(5-7)", "long(>=8)"]) {
        const g = groups[L];
        if (!g || g.n === 0) continue;
        console.log(`  ${L}: top1 ${((g.top1 / g.n) * 100).toFixed(1)}% (n=${g.n})`);
      }
    }
    if (args.failures > 0 && r.failures.length > 0) {
      r.failures.sort((a, b) => a.rank - b.rank);
      console.log(
        `--- top${args.topK} 外の事例（最大 ${args.failures} 件${isJp ? `, expand=${r.e ? "on" : "off"}` : ""}） ---`,
      );
      for (const f of r.failures.slice(0, args.failures)) {
        console.log(`[${f.rank}] ${f.key} — ${f.title} | top3: ${f.top.join(", ")}`);
      }
    }
  }
  Recommender.setExpandEnabled(true);

  // ---- 日本語ゴールデンセット（実ユーザーの論文テキスト、A/B: 展開の有無） ----
  if (isJp) {
    const gExtractor = (await pipeline("feature-extraction", model)) as FeatureExtractionPipeline;
    const gTexts = GOLDEN_JP.map((g) => `${g.title} ${g.keywords}`);
    const gOut = await gExtractor(gTexts, { pooling: "mean", normalize: true });
    const tensors = Array.isArray(gOut) ? gOut : [gOut];
    const gVecs: number[][] = [];
    for (const tensor of tensors) {
      const n = tensor.dims[0] ?? 1;
      const w = tensor.dims[1] ?? 384;
      const arr = Array.from(tensor.data as Float32Array | ArrayLike<number>);
      for (let j = 0; j < n; j++) gVecs.push(arr.slice(j * w, (j + 1) * w));
    }
    for (const expand of [true, false]) {
      Recommender.setExpandEnabled(expand);
      const gh = { top1: 0, top5: 0, top10: 0 };
      const gfail: Array<{ rank: number; key: string; title: string; top: string[] }> = [];
      for (let gi = 0; gi < GOLDEN_JP.length; gi++) {
        const g = GOLDEN_JP[gi]!;
        const scored: Array<[string, number]> = [];
        for (const c of confs) {
          const vocab = Recommender.breakdown(rowFor(c), [
            { title: g.title, keywords: g.keywords, venue: "" },
          ]).score as number;
          const sem = Recommender.semanticScore(c.key, gVecs[gi]!, venueEmb) as number;
          const gOpts = !args.wGiven
            ? { jp: true, len: Recommender.contentWordCount(`${g.title} ${g.keywords}`) }
            : { jp: true, jpw: args.jpw };
          scored.push([c.key, Recommender.blendScore(vocab, sem, gOpts) as number]);
        }
        scored.sort((a, b) => b[1] - a[1]);
        const rank = scored.findIndex((x) => x[0] === g.key) + 1;
        if (rank <= 1) gh.top1++;
        if (rank <= 5) gh.top5++;
        if (rank <= 10) gh.top10++;
        if (rank > args.topK) {
          gfail.push({
            rank,
            key: g.key,
            title: g.title,
            top: scored.slice(0, 3).map((s) => `${s[0]}(${s[1]}%)`),
          });
        }
      }
      const gn = GOLDEN_JP.length;
      const g1 = ((gh.top1 / gn) * 100).toFixed(1);
      const g5 = ((gh.top5 / gn) * 100).toFixed(1);
      const g10 = ((gh.top10 / gn) * 100).toFixed(1);
      console.log(
        `golden-jp (expand=${expand ? "on" : "off"}): top1: ${g1}%  top5: ${g5}%  top10: ${g10}%  (n=${gn})`,
      );
      if (args.failures > 0 && gfail.length > 0) {
        gfail.sort((a, b) => a.rank - b.rank);
        console.log(`  golden top${args.topK} 外（expand=${expand ? "on" : "off"}）:`);
        for (const f of gfail.slice(0, args.failures)) {
          console.log(`    [${f.rank}] ${f.key} — ${f.title} | top3: ${f.top.join(", ")}`);
        }
      }
    }
    Recommender.setExpandEnabled(true);
  }

  // ---- 擬似関連性フィードバック（PRF）: 掲載先タグ付きクエリ ----
  // タグ会議自身の埋め込みをクエリに 0.3 ブレンドしたとき、タグ会議が #1 になる率を測る
  if (args.prf && !isJp && emb.embeddings) {
    const prfSet = selected.slice(0, args.samples || 100).filter((q) => emb.embeddings[q.key]);
    const prfExtractor = (await pipeline("feature-extraction", model)) as FeatureExtractionPipeline;
    const prfQuery = (text: string): Promise<number[]> =>
      prfExtractor(text, { pooling: "mean", normalize: true }).then((out) => {
        const t = Array.isArray(out) ? out[0] : out;
        return Array.from(t.data as Float32Array | ArrayLike<number>);
      });
    const scoreAll = (qv: number[], q: { key: string; tw: string[] }): Array<[string, number]> => {
      const out: Array<[string, number]> = [];
      for (const c of confs) {
        const vocab = Recommender.breakdown(rowFor(c), [
          { title: q.tw.join(" "), keywords: "", venue: c.title || c.key },
        ]).score as number;
        const sem = Recommender.semanticScore(c.key, qv, venueEmb) as number;
        out.push([c.key, Recommender.blendScore(vocab, sem, { len: q.tw.length }) as number]);
      }
      out.sort((a, b) => b[1] - a[1]);
      return out;
    };
    const prfTop1 = { base: 0, blend: 0 };
    for (const q of prfSet) {
      const qv = await prfQuery(q.tw.join(" "));
      if (scoreAll(qv, q)[0]?.[0] === q.key) prfTop1.base++;
      const blended = Recommender.blendVectors(qv, emb.embeddings[q.key], 0.7) as number[];
      if (scoreAll(blended, q)[0]?.[0] === q.key) prfTop1.blend++;
    }
    const pn = prfSet.length;
    console.log(
      `prf (タグ=会議自身): #1 一致 ${((prfTop1.base / pn) * 100).toFixed(1)}% → ${((prfTop1.blend / pn) * 100).toFixed(1)}%  (n=${pn})`,
    );
  }
}

await main();
