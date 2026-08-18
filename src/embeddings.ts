/**
 * 会議スコープのセマンティック埋め込みを生成する (public/embeddings.json)。
 *
 * Ported from scripts/embeddings.py.  The Python original used fastembed; the
 * Node version uses @huggingface/transformers with the same model
 * (all-MiniLM-L6-v2), which is also what the browser side loads — one runtime
 * for both generator and consumer.
 *
 * 使い方:
 *   node src/embeddings.ts public/data.json public/embeddings.json
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type FeatureExtractionPipeline, pipeline } from "@huggingface/transformers";

export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_MULTI_MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
export const EMBEDDING_DIM = 384;
export const EMBEDDING_REVISION = "main";
export const EMBEDDING_SCHEMA_VERSION = 1;
export const EMBEDDING_PROBE = "kamiyobi embedding compatibility probe";

const extractorPromises = new Map<string, Promise<FeatureExtractionPipeline>>();

function getExtractor(
  model: string,
  revision = EMBEDDING_REVISION,
): Promise<FeatureExtractionPipeline> {
  const cacheKey = `${model}@${revision}`;
  let p = extractorPromises.get(cacheKey);
  if (!p) {
    p = pipeline("feature-extraction", model, { revision }) as Promise<FeatureExtractionPipeline>;
    extractorPromises.set(cacheKey, p);
  }
  return p;
}

/** Round to 6 decimal places like Python's round(float(x), 6). */
function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/** 日本語会議（情報処理学会・電子情報通信学会の研究会・特集号等）のプロファイルに
 * 付与する日本語の分野キーワード。多言語モデル用のみ（英語モデルには使わない）。
 * 実測（日本語ベンチ A/B）: これらを付与すると国内研究会のセマンティック検索が
 * top1 8.3%→25.0%・top5 16.7%→50.0% に改善（クエリの日本語語彙が会議に届く）。 */
const JP_CAT_KW: Record<string, string> = {
  systems:
    "カーネル スケジューリング 仮想化 オペレーティングシステム ミドルウェア ストレージ リアルタイム 組み込み メモリ",
  networking: "ネットワーク 通信 ルーティング 無線 プロトコル トラフィック",
  hpc: "ハイパフォーマンス スーパーコンピュータ 並列 GPU MPI",
  ai: "機械学習 深層学習 ニューラル 生成 推論",
  security: "セキュリティ プライバシー 暗号 認証",
  db: "データベース データマイニング 検索",
  graphics: "グラフィックス 可視化 映像 画像 レンダリング",
  hci: "ヒューマン ユーザインタフェース ユーザビリティ インタラクション",
  theory: "アルゴリズム 計算量 複雑性 グラフ",
};

function hasJapanese(text: string): boolean {
  return /[\u3040-\u9fff]/.test(text);
}

/** 会議のセマンティックプロファイルを実採択論文タイトルで強化する（R12）。
 * 会議名（International Conference on Machine Learning 等）だけでは実論文タイトル
 * （Batched Dueling Bandits 等）に似ず、実論文での正解会議が top5 に入らない
 * （golden EN 実測: top1 0.0%）ことが発端。代表論文タイトルをプロファイルに混ぜると
 * 「会議の実際の採択領域」を埋め込みに反映できる。
 *
 * データ源: 公式採択リスト（SOSP '25 sigops.org / NDSS '25 / ICML PMLR）。
 * bench の golden EN テストセット（GOLDEN_EN, src/bench-recommender.ts）とは
 * **完全に重複しないタイトルだけを使う**（リークなし検証）。
 */
/** Versioned venue-profile artifact loaded by both embedding and benchmark consumers. */
type VenueProfileArtifact = {
  schema: number;
  profiles_hash: string;
  profiles: Record<string, unknown>;
};

/** Canonical generator for the versioned venue-profile artifact. */
export function serializeVenueProfiles(profiles: Record<string, string[]>): string {
  const ordered: Record<string, string[]> = {};
  for (const key of Object.keys(profiles).sort()) {
    const papers = profiles[key];
    if (
      !key ||
      !Array.isArray(papers) ||
      papers.some((paper) => typeof paper !== "string" || !paper.trim())
    ) {
      throw new Error(`invalid venue profile entries: ${key}`);
    }
    ordered[key] = papers.slice();
  }
  const profiles_hash = createHash("sha256")
    .update(JSON.stringify(ordered))
    .digest("hex")
    .slice(0, 16);
  return `${JSON.stringify({ schema: 1, profiles_hash, profiles: ordered }, null, 2)}\n`;
}

function loadVenueProfiles(): Record<string, string[]> {
  const artifact = JSON.parse(
    readFileSync(new URL("../data/venue-profiles.json", import.meta.url), "utf8"),
  ) as VenueProfileArtifact;
  if (artifact.schema !== 1 || !artifact.profiles || typeof artifact.profiles !== "object") {
    throw new Error("invalid venue profile artifact schema");
  }
  const canonical = serializeVenueProfiles(artifact.profiles as Record<string, string[]>);
  const normalized = JSON.parse(canonical) as VenueProfileArtifact;
  if (artifact.profiles_hash !== normalized.profiles_hash) {
    throw new Error("venue profile artifact hash mismatch");
  }
  return normalized.profiles as Record<string, string[]>;
}

export const VENUE_PAPERS = loadVenueProfiles();

/** Stable hash of the generated venue profile data (embedding invalidation key). */
export function venuePapersHash(): string {
  return createHash("sha256").update(JSON.stringify(VENUE_PAPERS)).digest("hex").slice(0, 16);
}

function toStringArray(val: unknown): string[] {
  if (Array.isArray(val)) {
    return val
      .filter((x) => x !== null && x !== undefined)
      .map((x) => String(x).trim())
      .filter(Boolean);
  }
  if (typeof val === "string" && val.trim() !== "") {
    return [val.trim()];
  }
  return [];
}

/** 会議プロファイル文（カテゴリは正式名で展開）。
 * 多言語モデル用（forMulti）は、日本語名の会議にカテゴリの日本語キーワードを付与して
 * 日本語クエリから検索可能にする。英語モデルは日本語キーワードがノイズになるため
 * 付与しない（言語別の埋め込みを実測で分離した設計）。 */
export function profileTexts(
  confs: Array<Record<string, unknown>> | null | undefined,
  catNames?: Record<string, string> | null,
  forMulti = false,
): { keys: string[]; texts: string[] } {
  const keys: string[] = [];
  const texts: string[] = [];
  const safeCats = catNames ?? {};
  for (const c of confs ?? []) {
    if (!c || typeof c !== "object") continue;
    const key = String(c.key ?? "").trim();
    if (!key) continue;
    // カテゴリは短いキー（systems 等）より正式名（Systems, Architecture and Storage）で
    // 埋め込む方がセマンティック品質が高い（ベンチマークで実測）。
    const cats = toStringArray(c.categories);
    const catText = cats.map((k) => safeCats[k] || k).join(" ");
    const name = `${String(c.title ?? "")} ${String(c.full_name ?? "")}`;
    // 多言語モデル用: 日本語名の会議に日本語の分野語を付与（クエリ側の日本語語彙と一致させる）
    const jpKw = forMulti && hasJapanese(name) ? cats.map((k) => JP_CAT_KW[k] || "").join(" ") : "";
    // 実採択論文タイトル（あれば）でプロファイルを強化。英語モデルにのみ付与
    // （R12 実測: multi にも付けると日本語クエリの sem ランキングを乱す — 言語別分離設計）。
    // R13 実測: 「タイトル個別ベクトルの平均」方式（会議名 + 各タイトルを別々に埋めて
    // 平均）は golden top1 +2 エントリだが top5 -2・EN 合成 -3.6 で総合的に悪化 → 不採用。
    // 連結 mean pooling が最良（golden top5 73.5% / EN 合成 85.0%）。
    // R14 実測: rtss/ecrts は論文が多様（scheduling/WCET/TSN/AI/FPGA）で平均重心が
    // 汎用化し、無関係クエリ（memory safety 等）を奪う。埋め込みは会議名中心に保ち、
    // papers は語彙一致（scoreLine）でのみ使う。
    // usenix-security も 24 本が極めて多様（crypto/ML/web/ハードウェア/ブロックチェーン）で
    // 重心が汎用化しやすいため vocab-only（R15 実測で決定）
    // R17 A/B: icdcs を vocab-only にすると golden top5 65.7→62.9 に悪化（icdcs 自身の
    // golden 7 件を sem で拾う正の効果が奪取を上回る）→ 埋め込みは従来どおり維持。
    const skipEmb = SKIP_EMB_KEYS.has(key);
    const papers = !forMulti && !skipEmb ? (VENUE_PAPERS[key] ?? []).slice(0, 8).join(" . ") : "";
    const tags = toStringArray(c.tags);
    const parts = [
      String(c.title ?? ""),
      String(c.full_name ?? ""),
      catText,
      jpKw,
      tags.join(" "),
      papers,
    ];
    const text = parts.filter(Boolean).join(" ").trim();
    keys.push(key);
    texts.push(text || key);
  }
  return { keys, texts };
}

/** 1 モデルぶんの埋め込み表 {key: number[]} を生成する。
 * keys に同じ key が複数回現れる場合（会議名 + 各代表論文タイトル）は、
 * その平均ベクトルを返す（R13: 会議の採択領域の重心にする）。 */
async function embedSet(
  model: string,
  texts: string[],
  keys: string[],
  revision = EMBEDDING_REVISION,
): Promise<Record<string, number[]>> {
  const extractor = await getExtractor(model, revision);
  const sums = new Map<string, number[]>();
  const counts = new Map<string, number>();
  // メモリ節約のためバッチで処理
  const batch = 128;
  for (let start = 0; start < texts.length; start += batch) {
    const chunk = texts.slice(start, start + batch);
    const output = await extractor(chunk, { pooling: "mean", normalize: true });
    const tensors = Array.isArray(output) ? output : [output];
    let index = 0;
    for (const tensor of tensors) {
      const dims = tensor.dims;
      const n = dims.length >= 1 ? dims[0] : 1;
      const width = dims.length >= 2 ? dims[1] : EMBEDDING_DIM;
      const arr = Array.from(tensor.data as Float32Array | ArrayLike<number>);
      for (let i = 0; i < n; i++) {
        const key = keys[start + index];
        if (key !== undefined) {
          const vec = arr.slice(i * width, (i + 1) * width);
          const prev = sums.get(key);
          if (!prev) {
            sums.set(key, vec);
          } else {
            for (let d = 0; d < width; d++) prev[d] += vec[d];
          }
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        index += 1;
      }
    }
  }
  const out: Record<string, number[]> = {};
  for (const [key, sum] of sums) {
    const c = counts.get(key) ?? 1;
    const avg = sum.map((v) => v / c);
    const norm = Math.sqrt(avg.reduce((a, v) => a + v * v, 0)) || 1;
    out[key] = avg.map((v) => round6(v / norm));
  }
  return out;
}

/** 各テキストを個別ベクトルとして埋め込む（平均しない）。max 類似度用。 */
async function embedEach(
  model: string,
  texts: string[],
  revision = EMBEDDING_REVISION,
): Promise<number[][]> {
  const extractor = await getExtractor(model, revision);
  const out: number[][] = [];
  const batch = 128;
  for (let start = 0; start < texts.length; start += batch) {
    const chunk = texts.slice(start, start + batch);
    const output = await extractor(chunk, { pooling: "mean", normalize: true });
    const tensors = Array.isArray(output) ? output : [output];
    for (const tensor of tensors) {
      const dims = tensor.dims;
      const n = dims.length >= 1 ? dims[0] : 1;
      const width = dims.length >= 2 ? dims[1] : EMBEDDING_DIM;
      const arr = Array.from(tensor.data as Float32Array | ArrayLike<number>);
      for (let i = 0; i < n; i++) {
        const vec = arr.slice(i * width, (i + 1) * width);
        const norm = Math.sqrt(vec.reduce((a, v) => a + v * v, 0)) || 1;
        out.push(vec.map((v) => round6(v / norm)));
      }
    }
  }
  return out;
}

const SKIP_EMB_KEYS = new Set(["rtss", "ecrts", "usenix-security"]);

type EmbeddingData = {
  categories?: Record<string, unknown>;
  conferences?: Array<Record<string, unknown>>;
};

export type EmbeddingModelManifest = {
  model: string;
  revision: string;
  dim: number;
  probe: { text: string; vector: number[] };
};

export type EmbeddingManifest = {
  schema: number;
  profile_hash: string;
  keys: string[];
  venue_papers_hash: string;
  models: { en: EmbeddingModelManifest; multi: EmbeddingModelManifest };
  paper_vecs: { keys: string[]; dim: number };
};

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

function dataConferences(data: EmbeddingData | null | undefined): Array<Record<string, unknown>> {
  return (data?.conferences ?? [])
    .filter((c): c is Record<string, unknown> => Boolean(c && typeof c === "object"))
    .map((c) => ({
      key: String(c.key ?? "").trim(),
      title: String(c.title ?? ""),
      full_name: String(c.full_name ?? ""),
      categories: toStringArray(c.categories),
      tags: toStringArray(c.tags),
    }))
    .filter((c) => c.key)
    .sort((a, b) => String(a.key).localeCompare(String(b.key)));
}

function expectedPaperKeys(data: EmbeddingData | null | undefined): string[] {
  return dataConferences(data)
    .map((c) => String(c.key))
    .filter(
      (key) => ["usenix-security", "rtss"].includes(key) && (VENUE_PAPERS[key]?.length ?? 0) > 0,
    )
    .sort();
}

function modelManifest(model: string, probe: number[]): EmbeddingModelManifest {
  return {
    model,
    revision: EMBEDDING_REVISION,
    dim: EMBEDDING_DIM,
    probe: { text: EMBEDDING_PROBE, vector: probe },
  };
}

/** Hash every input that changes profile vectors, not only the output key set. */
export function embeddingProfileHash(data: EmbeddingData | null | undefined): string {
  const profile = {
    schema: EMBEDDING_SCHEMA_VERSION,
    models: {
      en: modelManifest(EMBEDDING_MODEL, []),
      multi: modelManifest(EMBEDDING_MULTI_MODEL, []),
    },
    categories: data?.categories ?? {},
    conferences: dataConferences(data).map((c) => ({
      ...c,
      papers: VENUE_PAPERS[String(c.key)] ?? [],
    })),
    profile_rules: {
      jp_category_keywords: JP_CAT_KW,
      skip_embedding_keys: [...SKIP_EMB_KEYS].sort(),
      english_papers: "first-eight-concatenated",
      multilingual_papers: "excluded",
    },
  };
  return createHash("sha256")
    .update(JSON.stringify(stableValue(profile)))
    .digest("hex")
    .slice(0, 16);
}

export function embeddingManifest(
  data: EmbeddingData | null | undefined,
  probes: { en?: number[]; multi?: number[] } = {},
): EmbeddingManifest {
  const keys = dataConferences(data).map((c) => String(c.key));
  return {
    schema: EMBEDDING_SCHEMA_VERSION,
    profile_hash: embeddingProfileHash(data),
    keys,
    venue_papers_hash: venuePapersHash(),
    models: {
      en: modelManifest(EMBEDDING_MODEL, probes.en ?? []),
      multi: modelManifest(EMBEDDING_MULTI_MODEL, probes.multi ?? []),
    },
    paper_vecs: { keys: expectedPaperKeys(data), dim: EMBEDDING_DIM },
  };
}

export async function buildEmbeddings(
  dataPath: string,
  outPath: string,
): Promise<Record<string, number[]>> {
  const data = JSON.parse(readFileSync(dataPath, "utf8")) as {
    conferences: Array<Record<string, unknown>>;
    categories?: Record<string, string>;
  };
  const catNames = (data.categories ?? {}) as Record<string, string>;
  const en = profileTexts(data.conferences, catNames, false);
  const multiTexts = profileTexts(data.conferences, catNames, true);

  // 言語適応型デュアルモデル（実測ベース）:
  // 英語は all-MiniLM-L6-v2（EN top1 80.1%）、日本語は paraphrase-multilingual
  // （JP top1 19.0% → 42.9%）。一方だけだと他方が落ちるため両方持つ。
  // 多言語側は日本語会議に日本語キーワードを付与（国内研究会の検索改善、実測済み）。
  const out = await embedSet(EMBEDDING_MODEL, en.texts, en.keys, EMBEDDING_REVISION);
  const multi = await embedSet(
    EMBEDDING_MULTI_MODEL,
    multiTexts.texts,
    multiTexts.keys,
    EMBEDDING_REVISION,
  );
  const [enProbe] = await embedEach(EMBEDDING_MODEL, [EMBEDDING_PROBE], EMBEDDING_REVISION);
  const [multiProbe] = await embedEach(
    EMBEDDING_MULTI_MODEL,
    [EMBEDDING_PROBE],
    EMBEDDING_REVISION,
  );

  // skipEmb 会議（rtss/ecrts/usenix-security）の論文個別ベクトル（R16）。
  // R14 で「多様な論文の平均重心の汎用化」が判明し埋め込みから外したが、その副作用で
  // 会議名のみの埋め込みになり実論文タイトルからセマンティックに発見されなくなった
  // （golden EN top1 15.8% vs top5 63.2% の乖離の主因）。R13 の「個別ベクトルの平均」は
  // 却下済みのため、max 類似度（クエリが採択論文のどれかに近ければ会議に近い）を
  // A/B する。英語モデルのみ（R12 の言語別分離: multi に英語論文語彙を混ぜると
  // 日本語クエリの順位を乱す）。
  const paperVecs: Record<string, number[][]> = {};
  // R16 A/B: rtss/ecrts は論文が多様（22+9 本）で max が「1 本でも近い」誤マッチを
  // 起こす（Beehive→rtss 50%、BULKHEAD→rtss 38% 等の実測）。usenix-security のみ
  // paperVecs を付与し、rtss/ecrts は R14 の「語彙のみ」を維持する。
  // R17 A/B 結果: ches を paperVecs に足すと top5 65.7→64.3 に悪化（FPGA/AES 語彙が
  // BULKHEAD/Beehive 等を奪う）→ usenix-security のみ維持。
  // R20 A/B: rtss を再追加（Timely Classification 対策）。R16 で「多様な papers の
  // max 誤爆」（Beehive→rtss 50% 等）で却下されたが、R19 の語境界・GENERIC 導入後に
  // 再検証する。golden EN 全体で悪化しなければ採用、悪化すれば usenix のみに戻す。
  // R21 A/B: rtas を試すと top1 +2.5pt だが top5 −2.5pt（既存 2 件
  // CounterSEVeillance/One-Size-Fits-None を奪い新規獲得 0）→ 不採用。
  // rtas は VENUE_PAPERS 語彙のみで 8 件中 6 件 top5 を達成。
  for (const key of ["usenix-security", "rtss"]) {
    const papers = VENUE_PAPERS[key] ?? [];
    if (!papers.length) continue;
    // 論文タイトルを**個別に**埋め込む（平均しない — max 類似度で使うため）。
    // embedSet は key ごとに平均するので使えない。
    const vecs = await embedEach(EMBEDDING_MODEL, papers, EMBEDDING_REVISION);
    paperVecs[key] = vecs;
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    JSON.stringify({
      model: EMBEDDING_MODEL,
      dim: EMBEDDING_DIM,
      venuePapersHash: venuePapersHash(),
      manifest: embeddingManifest(data, { en: enProbe, multi: multiProbe }),
      embeddings: out,
      multi: {
        model: EMBEDDING_MULTI_MODEL,
        dim: EMBEDDING_DIM,
        embeddings: multi,
      },
      paperVecs,
    }),
    "utf8",
  );
  return out;
}

function extractArgvRest(argv: string[] | null | undefined): string[] {
  if (!argv || !Array.isArray(argv)) return [];
  if (argv.length === 0) return [];
  const isNodeBin = (s: string): boolean =>
    s === "node" || s === "bun" || /(?:^|[/\\])(?:node|bun)(?:\.exe)?$/i.test(s);
  const isScript = (s: string): boolean =>
    /(?:^|[/\\])(?:cli|bench|embeddings|discover|review|fetch-primary)(?:[-_a-z0-9]*)?\.[jt]sx?$/i.test(
      s,
    );

  if (isNodeBin(argv[0])) {
    if (argv.length > 1 && (isScript(argv[1]) || !argv[1].startsWith("-"))) {
      return argv.slice(2);
    }
    return argv.slice(1);
  }
  if (isScript(argv[0])) {
    return argv.slice(1);
  }
  return argv.slice(0);
}

export async function main(argv: string[] | null | undefined): Promise<number> {
  const rawArgs = extractArgvRest(argv);
  if (rawArgs.length === 0) {
    process.stderr.write(
      "usage: node src/embeddings.ts [--force|-f] <data.json> <embeddings.json>\n",
    );
    return 2;
  }
  if (rawArgs.includes("--help") || rawArgs.includes("-h") || rawArgs.includes("help")) {
    console.log("usage: node src/embeddings.ts [--force|-f] <data.json> <embeddings.json>");
    return 0;
  }
  let force = false;
  const args: string[] = [];
  for (const raw of rawArgs) {
    let a = raw;
    let eqVal: string | undefined;
    const eqIdx = raw.indexOf("=");
    if (raw.startsWith("-") && eqIdx > 0) {
      a = raw.slice(0, eqIdx);
      eqVal = raw.slice(eqIdx + 1);
    }
    const boolVal = (): boolean => {
      if (eqVal === undefined) return true;
      const low = eqVal.toLowerCase();
      return low !== "false" && low !== "0" && low !== "no" && low !== "off";
    };
    if (a === "--force" || a === "-f") {
      force = boolVal();
    } else {
      args.push(raw);
    }
  }
  if (args.length !== 2) {
    process.stderr.write(
      "usage: node src/embeddings.ts [--force|-f] <data.json> <embeddings.json>\n",
    );
    return 2;
  }
  const dataPath = args[0];
  const outPath = args[1];
  let dataExists = true;
  try {
    readFileSync(dataPath);
  } catch {
    dataExists = false;
  }
  if (!dataExists) {
    process.stderr.write(`data not found: ${dataPath}\n`);
    return 1;
  }
  if (!force) {
    let outExists = false;
    try {
      readFileSync(outPath);
      outExists = true;
    } catch {
      outExists = false;
    }
    if (outExists) {
      process.stderr.write(`embeddings already exist: ${outPath} (skip)\n`);
      return 0;
    }
  }
  const out = await buildEmbeddings(dataPath, outPath);
  console.log(`embeddings written: ${Object.keys(out).length} conferences -> ${outPath}`);
  return 0;
}

const isMain = Boolean(
  process.argv[1] &&
    (process.argv[1].endsWith("embeddings.ts") || process.argv[1].endsWith("embeddings.js")),
);
if (isMain) {
  main(process.argv).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err);
      process.exitCode = 1;
    },
  );
}
