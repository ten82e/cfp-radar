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

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type FeatureExtractionPipeline, pipeline } from "@huggingface/transformers";

export const EMBEDDING_MODEL = "sentence-transformers/all-MiniLM-L6-v2";
export const EMBEDDING_DIM = 384;

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

function getExtractor(): Promise<FeatureExtractionPipeline> {
  extractorPromise ??= pipeline(
    "feature-extraction",
    EMBEDDING_MODEL,
  ) as Promise<FeatureExtractionPipeline>;
  return extractorPromise;
}

/** Round to 6 decimal places like Python's round(float(x), 6). */
function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

export async function buildEmbeddings(
  dataPath: string,
  outPath: string,
): Promise<Record<string, number[]>> {
  const data = JSON.parse(readFileSync(dataPath, "utf8")) as {
    conferences: Array<Record<string, unknown>>;
  };
  const confs = data.conferences;

  const extractor = await getExtractor();
  const texts: string[] = [];
  const keys: string[] = [];
  for (const c of confs) {
    const key = String(c.key ?? "");
    const parts = [
      String(c.title ?? ""),
      String(c.full_name ?? ""),
      ((c.categories as string[] | null) ?? []).join(" "),
      ((c.tags as string[] | null) ?? []).join(" "),
    ];
    const text = parts.filter(Boolean).join(" ").trim();
    texts.push(text || key);
    keys.push(key);
  }

  const out: Record<string, number[]> = {};
  const output = await extractor(texts, { pooling: "mean", normalize: true });
  const tensors = Array.isArray(output) ? output : [output];
  let index = 0;
  for (const tensor of tensors) {
    const dims = tensor.dims;
    const n = dims.length >= 1 ? dims[0] : 1;
    const width = dims.length >= 2 ? dims[1] : 384;
    const arr = Array.from(tensor.data as Float32Array | ArrayLike<number>);
    for (let i = 0; i < n; i++) {
      const key = keys[index];
      if (key !== undefined) {
        out[key] = arr.slice(i * width, (i + 1) * width).map(round6);
      }
      index += 1;
    }
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    JSON.stringify({
      model: EMBEDDING_MODEL,
      dim: EMBEDDING_DIM,
      embeddings: out,
    }),
    "utf8",
  );
  return out;
}

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  if (args.length !== 2) {
    process.stderr.write("usage: node src/embeddings.ts <data.json> <embeddings.json>\n");
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
  const out = await buildEmbeddings(dataPath, outPath);
  console.log(`embeddings written: ${Object.keys(out).length} conferences -> ${outPath}`);
  return 0;
}

const isMain = process.argv[1]?.endsWith("embeddings.ts");
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
