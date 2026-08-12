/**
 * Entry point: node src/cli.ts build [options]
 * Ported from scripts/cli.py (cfp-radar).
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load as loadYaml } from "js-yaml";
import { buildAll } from "./build.ts";
import {
  applyAliases,
  applyOverrides,
  classify,
  dedupDeadlinesAfterRollforward,
  type MergeStats,
  mergeSources,
  rollforward,
  sanitizeEditions,
  select,
} from "./merge.ts";
import { type Conference, cmpStr, conferencesFromJson, warn, warningCounts } from "./model.ts";
import { AideadlinesSource } from "./sources/aideadlines.ts";
import { CcfddlSource } from "./sources/ccfddl.ts";
import { LocalSource } from "./sources/local.ts";

// ROOT はテストから差し替え可能（let）。
export let ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function setRoot(root: string): void {
  ROOT = root;
}

export function parseNow(text: string | null | undefined): Date {
  if (!text) return new Date();
  let value = text.trim();
  if (value.endsWith("Z") || value.endsWith("z")) {
    value = `${value.slice(0, -1)}+00:00`;
  }
  const normalized = value.replace(" ", "T");
  const dt = new Date(normalized);
  if (Number.isNaN(dt.getTime())) {
    throw new Error(`unparsable --now: ${JSON.stringify(text)}`);
  }
  return dt;
}

function loadYamlFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const loaded = loadYaml(readFileSync(path, "utf8"));
    return typeof loaded === "object" && loaded !== null ? (loaded as Record<string, unknown>) : {};
  } catch (exc) {
    // 静かに {} を返すと primary_overrides 等のエントリが全滅するのにビルドは
    // 成功し続ける（2026-08-12 whpc で実証）。必ず警告を出す。
    warn(`cannot parse ${path}: ${String(exc)}`);
    return {};
  }
}

function sourceInstances(): Array<{
  name: string;
  load: (cache: string, opts?: { offline?: boolean }) => Promise<unknown[]>;
}> {
  return [new CcfddlSource(), new AideadlinesSource(), new LocalSource()];
}

async function collectImpl(
  cacheDir: string,
  options: { offline?: boolean },
): Promise<{ groups: Conference[][]; failed: Set<string> }> {
  const groups: Conference[][] = [];
  const failed = new Set<string>();
  for (const source of sourceInstances()) {
    let group: unknown[] = [];
    try {
      group = await source.load(cacheDir, options);
    } catch (exc) {
      process.stderr.write(`warning: source ${source.name} の取得に失敗した: ${String(exc)}\n`);
      group = [];
    }
    if (group.length === 0 && source.name !== "local") {
      failed.add(source.name);
    }
    groups.push(group as Conference[]);
  }
  return { groups, failed };
}

// テストから差し替え可能（Python 版の monkeypatch 相当）。ESM の let 束縛は
// 外部から代入できないためオブジェクト経由にする。
export const hooks = { collect: collectImpl };

function restoreSnapshot(path: string): Conference[] {
  if (!existsSync(path)) return [];
  try {
    const payload = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return conferencesFromJson(payload);
  } catch (exc) {
    process.stderr.write(`warning: ${path} を読めない: ${String(exc)}\n`);
    return [];
  }
}

export interface BuildArgs {
  out: string;
  config: string;
  offline: boolean;
  now: string | null;
  cache: string;
  noEmbeddings?: boolean;
}

export async function cmdBuild(args: BuildArgs): Promise<number> {
  const now = parseNow(args.now);
  const configPath = isAbsolute(args.config) ? args.config : join(ROOT, args.config);
  const config = loadYamlFile(configPath);
  const overrides = loadYamlFile(join(ROOT, "data", "overrides.yaml"));
  // 一次ソースからの自動抽出結果 (src/fetch-primary.ts 生成) は手書き
  // overrides の後に適用する: 公式ページの実測が最優先。
  const primary = loadYamlFile(join(ROOT, "data", "primary_overrides.yaml"));
  const offline = Boolean(args.offline);

  const snapshot = join(ROOT, "data", "snapshot.json");

  const { groups, failed } = await hooks.collect(resolve(args.cache), { offline });
  const aliased = applyAliases(groups, overrides.aliases as Record<string, unknown> | undefined);
  const mergeStats: MergeStats = { merged_deadlines: 0, merged_by_key: {} };
  let confs = mergeSources(aliased, config, mergeStats);
  confs = classify(confs, config);
  confs = applyOverrides(confs, overrides);
  confs = applyOverrides(confs, primary);
  confs = sanitizeEditions(confs);
  confs = rollforward(
    confs,
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
    config,
  );
  // SPEC.md 3.6: roll-forward copies a real edition's deadlines into the
  // estimated one, so the fold runs once more behind it.
  confs = dedupDeadlinesAfterRollforward(confs, config, mergeStats);
  confs = select(confs, config);

  // SPEC.md section 3.5: an upstream outage must not gut the published site.
  const degraded = failed.size > 0;
  if (degraded) {
    const restored = restoreSnapshot(snapshot);
    if (restored.length > confs.length) {
      process.stderr.write(
        `warning: 上流 ${[...failed].sort().join(",")} が取得できないため ${snapshot} から ${restored.length} 会議で生成する\n`,
      );
      confs = restored;
    } else {
      process.stderr.write(
        `error: 上流 ${[...failed].sort().join(",")} が取得できず、退避に使える ${snapshot} も無い（${confs.length} 会議）。縮退した内容を配信しないため中断する\n`,
      );
      return 2;
    }
  }

  const outdir = resolve(args.out);
  const stats = await buildAll(confs, config, outdir, now, {
    noEmbeddings: Boolean(args.noEmbeddings),
  });
  // 統合件数は出力に載った会議のぶんだけ数える。
  const byKey = mergeStats.merged_by_key ?? {};
  stats.merged = degraded ? 0 : confs.reduce((n, c) => n + (byKey[c.key] ?? 0), 0);

  // 縮退したまま書き戻すと退避データそのものを壊すので、健全なときだけ更新する。
  if (!degraded && !offline && existsSync(join(outdir, "data.json"))) {
    copyFileSync(join(outdir, "data.json"), snapshot);
  }

  console.log(
    `built ${stats.conferences} conferences / ${stats.editions} editions / ${stats.deadlines} deadlines / ${stats.events} events (${stats.estimated} estimated, ${stats.merged} merged) -> ${outdir}`,
  );
  // Surface parse/fetch soft-warnings so CI logs and operators can see them.
  const counts = warningCounts();
  if (Object.keys(counts).length > 0) {
    const top = Object.entries(counts)
      .sort((a, b) => b[1] - a[1] || cmpStr(a[0], b[0]))
      .slice(0, 8);
    const summary = top.map(([msg, n]) => `${n}× ${msg}`).join("; ");
    process.stderr.write(
      `warnings: ${Object.values(counts).reduce((a, b) => a + b, 0)} (${summary})\n`,
    );
  }
  return 0;
}

interface DiscoverArgs {
  out: string | null;
  categories: string | null;
  minYear: number;
  dryRun: boolean;
  append: boolean;
}

export async function cmdDiscover(args: DiscoverArgs): Promise<number> {
  const { NicheDiscoverer, formatDiscoveredYaml } = await import("./discover.ts");
  const categories = args.categories ? args.categories.split(",").map((c) => c.trim()) : null;
  const discoverer = new NicheDiscoverer(ROOT);
  console.log(
    `Running niche venue & journal discovery (categories: ${categories?.join(",") ?? "all"})...`,
  );
  const candidates = await discoverer.runDiscovery(categories ?? null, args.minYear);

  console.log(`Discovered ${candidates.length} new niche venue/journal candidates.`);
  for (const cand of candidates.slice(0, 10)) {
    console.log(`  - [${cand.key}] ${cand.title}: ${cand.full_name} (${cand.link})`);
  }

  const yamlText = formatDiscoveredYaml(candidates);

  if (args.append && args.out && candidates.length > 0) {
    // 既存 YAML の conferences に、key が被らない候補だけ追記する。
    const outPath = args.out;
    const existing = loadYamlFile(outPath) as Record<string, unknown>;
    const existingConfs = (existing.conferences as Array<Record<string, unknown>> | null) ?? [];
    const seen = new Set(existingConfs.map((c) => c.key));
    const parsed = loadYaml(yamlText) as { conferences?: Array<Record<string, unknown>> };
    const newConfs = (parsed.conferences ?? []).filter((c) => !seen.has(c.key));
    existing.conferences = [...existingConfs, ...newConfs];
    const { dump } = await import("js-yaml");
    writeTextFile(outPath, dump(existing, { skipInvalid: true }));
    console.log(`\nAppended ${newConfs.length} candidates to ${outPath}`);
  } else if (args.dryRun) {
    console.log("\n--- Dry Run Output (extra.yaml format) ---");
    console.log(yamlText.slice(0, 1000) + (yamlText.length > 1000 ? "..." : ""));
  } else if (args.out) {
    writeTextFile(args.out, yamlText);
    console.log(`\nSaved candidates YAML to ${args.out}`);
  }
  return 0;
}

function writeTextFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

interface CliArgs {
  command?: string;
  out?: string;
  config?: string;
  offline?: boolean;
  now?: string | null;
  cache?: string;
  categories?: string | null;
  minYear?: number;
  dryRun?: boolean;
  append?: boolean;
  noEmbeddings?: boolean;
}

function usage(): string {
  return [
    "usage: node src/cli.ts <command> [options]",
    "",
    "commands:",
    "  build    収集して public/ を生成する",
    "    --out <dir>       出力先ディレクトリ (default: public)",
    "    --config <path>   設定ファイル (default: config.yaml)",
    "    --offline         ネットワークを使わずキャッシュのみ使う",
    "    --now <iso>       基準時刻。例 2026-08-09T00:00:00Z",
    "    --cache <dir>     上流 tarball のキャッシュ先 (default: .cache)",
    "    --no-embeddings   埋め込み (embeddings.json) を生成しない（テスト用・高速化）",
    "  discover 穴場の会議・ジャーナルを自律探索する",
    "    --out <path>      出力YAMLパス（未指定時は標準出力表示）",
    "    --categories <s>  カンマ区切りの対象カテゴリ（例: hpc,systems）",
    "    --min-year <n>    対象の最小年 (default: 2026)",
    "    --dry-run         ファイル出力せず結果をプレビュー表示",
    "    --append          既存 YAML に key 重複なしで追記",
  ].join("\n");
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string | undefined => argv[i + 1];
    if (a === "--out") {
      args.out = next() ?? "public";
      i += 1;
    } else if (a === "--config") {
      args.config = next() ?? "config.yaml";
      i += 1;
    } else if (a === "--cache") {
      args.cache = next() ?? ".cache";
      i += 1;
    } else if (a === "--now") {
      args.now = next() ?? null;
      i += 1;
    } else if (a === "--categories") {
      args.categories = next() ?? null;
      i += 1;
    } else if (a === "--min-year") {
      args.minYear = Number(next() ?? 2026);
      i += 1;
    } else if (a === "--offline") {
      args.offline = true;
    } else if (a === "--no-embeddings") {
      args.noEmbeddings = true;
    } else if (a === "--dry-run") {
      args.dryRun = true;
    } else if (a === "--append") {
      args.append = true;
    } else if (a.startsWith("-")) {
      throw new Error(`unknown option: ${a}`);
    } else {
      positional.push(a);
    }
  }
  args.command = positional[0];
  return args;
}

export async function main(argv: string[]): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv.slice(2));
  } catch (exc) {
    process.stderr.write(`error: ${String(exc)}\n\n${usage()}\n`);
    return 2;
  }
  if (args.command === "build") {
    return cmdBuild({
      out: args.out ?? "public",
      config: args.config ?? "config.yaml",
      offline: Boolean(args.offline),
      now: args.now ?? null,
      cache: args.cache ?? ".cache",
      noEmbeddings: Boolean(args.noEmbeddings),
    });
  }
  if (args.command === "discover") {
    return cmdDiscover({
      out: args.out ?? null,
      categories: args.categories ?? null,
      minYear: args.minYear ?? 2026,
      dryRun: Boolean(args.dryRun),
      append: Boolean(args.append),
    });
  }
  process.stderr.write(`${usage()}\n`);
  return 2;
}

const isMain = process.argv[1]?.endsWith("cli.ts");
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
