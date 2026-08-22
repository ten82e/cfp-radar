/**
 * Entry point: node src/cli.ts build [options]
 * Ported from scripts/cli.py (kamiyobi).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { resolvePrimaryObservations } from "./sources/primary.ts";

// ROOT はテストから差し替え可能（let）。
export let ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MIN_YEAR = new Date().getUTCFullYear();

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
  // Date は '2026-02-30' 等の不可能な暦日を黙って翌月へ繰り上げる
  // (parseInstant / asDate と同じ round-trip の流儀で拒否する)。
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(normalized);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const chk = new Date(Date.UTC(y, mo - 1, d));
    if (chk.getUTCFullYear() !== y || chk.getUTCMonth() !== mo - 1 || chk.getUTCDate() !== d) {
      throw new Error(`unparsable --now: ${JSON.stringify(text)}`);
    }
  }
  // Date は時刻あり・offset 無しをローカル時刻にし、T24:00:00Z を翌日へ繰り上げる。
  // --now は決定的テスト用（SPEC §3.7）なので、どちらも拒否する (#392)。
  const time = /T(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(.*)$/.exec(normalized);
  if (time) {
    const hour = Number(time[1]);
    const minute = Number(time[2]);
    const second = Number(time[3] ?? "0");
    const zone = time[4] ?? "";
    if (hour > 23 || minute > 59 || second > 59 || !/^[+-]\d{2}:?\d{2}$/.test(zone)) {
      throw new Error(`unparsable --now: ${JSON.stringify(text)}`);
    }
  }
  const dt = new Date(normalized);
  if (Number.isNaN(dt.getTime())) {
    throw new Error(`unparsable --now: ${JSON.stringify(text)}`);
  }
  return dt;
}

function loadYamlFile(path: string, opts?: { strict?: boolean }): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const loaded = loadYaml(readFileSync(path, "utf8"));
    return typeof loaded === "object" && loaded !== null ? (loaded as Record<string, unknown>) : {};
  } catch (exc) {
    // 静かに {} を返すと primary_overrides 等のエントリが全滅するのにビルドは
    // 成功し続ける（2026-08-12 whpc で実証）。必ず警告を出す。
    if (opts?.strict) {
      // 手編集の入力 (config.yaml / data/overrides.yaml) は、破損したまま
      // 警告だけで続行すると公式締切の訂正が消えたり縮退サイトが配信されたり
      // する（2026-08-13 実証）。SPEC.md 3.5 の「縮退した内容を配信しない」
      // 契約に合わせて中断させる（main の rejection handler が exit 1 にする）。
      throw new Error(`cannot parse ${path}: ${String(exc)}`);
    }
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
  const config = loadYamlFile(configPath, { strict: true });
  // 一次ソースからの自動抽出結果 (src/fetch-primary.ts 生成) は手書き
  // overrides の後に適用する: 公式ページの実測が最優先。
  // overrides は手編集なのでパース失敗で中断する（strict）。primary は
  // 自動生成のため従来どおり警告続行（2026-08-12 whpc の趣旨）。
  const overrides = loadYamlFile(join(ROOT, "data", "overrides.yaml"), { strict: true });
  // 一次ソースの自動抽出は「検証済み観測」だけを確定値として扱う (#504):
  // 日付のみ・曖昧 tz・年不一致の行はここで落とし、既存の確定値を保持する。
  const primary = resolvePrimaryObservations(
    loadYamlFile(join(ROOT, "data", "primary_overrides.yaml")),
  );
  // data/extra.yaml も手編集入力（#19/#20 の対象外だった）。破損時に
  // local 会議 ~169 件が消えた縮退サイトを配信してしまうため、overrides と
  // 同格に strict 検証して中断する（2026-08-15 実証: 349 vs 518 会議・exit 0）。
  loadYamlFile(join(ROOT, "data", "extra.yaml"), { strict: true });
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
  let snapshotFallback = false;
  if (degraded) {
    const restored = restoreSnapshot(snapshot);
    if (restored.length > confs.length) {
      snapshotFallback = restored.length > 0;
      process.stderr.write(
        `warning: 上流 ${[...failed].sort().join(",")} が取得できないため ${snapshot} から ${restored.length} 会議で生成する\n`,
      );
      confs = restored;
      // 退避 snapshot は最後に健全な online ビルドが生成した時点のデータのため、
      // その後 merge された overrides（締切修正・estimated 昇格・新規 edition 追加）を
      // 含まないことがある。上流障害時の退避配信で修正済み締切が推定値へ巻き戻らないよう、
      // 復元データにも overrides / primary を再適用する。applyOverrides は冪等なので、
      // snapshot が既に overrides 込みのときは値が変わらない（SPEC.md 3.5）。
      // 同様に local (data/extra.yaml) も上流障害時には読めるため、snapshot 生成後に
      // extra.yaml へ追加された会議・締切（新規収録・通知締切など）が退避配信から
      // 消えないよう復元データに再マージする。mergeSources は key/edition で名寄せし、
      // local は source_priority 最上位なので snapshot 側の古い締切を正しく上書きする。
      const localGroup = groups[sourceInstances().findIndex((s) => s.name === "local")] ?? [];
      if (localGroup.length > 0) {
        confs = mergeSources([localGroup, restored], config, mergeStats);
        confs = classify(confs, config);
        confs = sanitizeEditions(confs);
        // mergeSources は追加・上書きのみで削除を表現できない。snapshot に残る
        // 「sources が local のみ」のキーで extra.yaml に存在しないものは
        // 削除された会議として除外する（例: ieee-msn 重複削除が snapshot から復活する事故）。
        const localKeys = new Set(localGroup.map((c) => c.key));
        confs = confs.filter(
          (c) => !(c.sources.length === 1 && c.sources[0] === "local" && !localKeys.has(c.key)),
        );
      }
      confs = applyOverrides(confs, overrides);
      confs = applyOverrides(confs, primary);
      confs = sanitizeEditions(confs);
      confs = select(confs, config);
    } else if (confs.length === 0) {
      process.stderr.write(
        `error: 上流 ${[...failed].sort().join(",")} が取得できず、退避に使える ${snapshot} も無い（${confs.length} 会議）。縮退した内容を配信しないため中断する\n`,
      );
      return 2;
    } else {
      process.stderr.write(
        `warning: 上流 ${[...failed].sort().join(",")} が取得できないが、成功した ${confs.length} 会議で継続する（SPEC.md 3.5）\n`,
      );
      const liveKeys = new Set(confs.map((c) => c.key));
      const extras = restored.filter(
        (c) => !liveKeys.has(c.key) && c.sources.some((s) => failed.has(s)),
      );
      if (extras.length > 0) {
        snapshotFallback = true;
        confs = [...confs, ...extras];
        confs = applyOverrides(confs, overrides);
        confs = applyOverrides(confs, primary);
        confs = sanitizeEditions(confs);
        confs = select(confs, config);
      }
    }
  }

  const outdir = resolve(args.out);
  const healthConfig = (config.health as Record<string, unknown> | undefined) ?? {};
  const requiredVenues = Array.isArray(healthConfig.required_venues)
    ? healthConfig.required_venues.map((key) => String(key))
    : [];
  const stats = await buildAll(confs, config, outdir, now, {
    noEmbeddings: Boolean(args.noEmbeddings),
    health: {
      sourceStatus: Object.fromEntries(
        sourceInstances().map((source) => [
          source.name,
          failed.has(source.name) ? "failed" : "success",
        ]),
      ),
      sourceFailures: [...failed],
      snapshotFallback,
      requiredVenues,
      parseWarnings: warningCounts(),
    },
  });
  // 統合件数は出力に載った会議のぶんだけ数える。
  const byKey = mergeStats.merged_by_key ?? {};
  stats.merged = degraded ? 0 : confs.reduce((n, c) => n + (byKey[c.key] ?? 0), 0);

  // 縮退したまま書き戻すと退避データそのものを壊すので、健全なときだけ更新する。
  // SPEC.md 3.5: snapshot は data.json のコピーだが「generated_at を含まない」。
  // 素コピーだと --now 指定の検証ビルドが架空の generated_at を退避データに焼き込む。
  if (!degraded && !offline && existsSync(join(outdir, "data.json"))) {
    const payload = JSON.parse(readFileSync(join(outdir, "data.json"), "utf8")) as Record<
      string,
      unknown
    >;
    delete payload.generated_at;
    writeFileSync(snapshot, JSON.stringify(payload), "utf8");
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
  candidateOut: string | null;
  categories: string | null;
  minYear: number;
  dryRun: boolean;
  append: boolean;
}

export type DiscoverWriteAction = "append" | "dry-run" | "write" | "none";

/**
 * cmdDiscover の出力分岐を決める（純関数。テスト可能）。
 * `--append` 指定時に候補が 0 件でも「何もしない」を返し、素通し上書きで
 * 蓄積ファイルが空になる事故（#267）を防ぐ。
 */
export function discoverWriteAction(
  count: number,
  append: boolean,
  out: string | null,
  dryRun: boolean,
): DiscoverWriteAction {
  if (append && out) return count > 0 ? "append" : "none";
  if (dryRun) return "dry-run";
  if (out) return "write";
  return "none";
}

export async function cmdDiscover(args: DiscoverArgs): Promise<number> {
  const {
    NicheDiscoverer,
    formatCandidateRegistry,
    formatDiscoveredYaml,
    mergeCandidateRegistry,
    parseCandidateRegistry,
  } = await import("./discover.ts");
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
  const candidatePath = args.candidateOut ?? join(ROOT, "data", "discovered_candidates.yaml");
  const candidatePathResolved = isAbsolute(candidatePath)
    ? candidatePath
    : join(ROOT, candidatePath);
  const existingRegistry = parseCandidateRegistry(
    loadYamlFile(candidatePathResolved, { strict: true }),
  );
  const registry = mergeCandidateRegistry(existingRegistry, candidates, new Date().toISOString());
  const action = discoverWriteAction(candidates.length, args.append, args.out, args.dryRun);

  if (action === "append") {
    // 既存 YAML の conferences に、key が被らない候補だけ追記する。
    const outPath = isAbsolute(args.out!) ? args.out! : join(ROOT, args.out!);
    const existing = loadYamlFile(outPath) as Record<string, unknown>;
    const existingConfs = (existing.conferences as Array<Record<string, unknown>> | null) ?? [];
    const seen = new Set(existingConfs.map((c) => c.key));
    const parsed = loadYaml(yamlText) as { conferences?: Array<Record<string, unknown>> };
    const newConfs = (parsed.conferences ?? []).filter((c) => !seen.has(c.key));
    existing.conferences = [...existingConfs, ...newConfs];
    const { dump } = await import("js-yaml");
    writeTextFile(outPath, dump(existing, { skipInvalid: true }));
    console.log(`\nAppended ${newConfs.length} candidates to ${outPath}`);
  } else if (action === "dry-run") {
    console.log("\n--- Dry Run Output (extra.yaml format) ---");
    console.log(yamlText.slice(0, 1000) + (yamlText.length > 1000 ? "..." : ""));
  } else if (action === "write") {
    const outPath = isAbsolute(args.out!) ? args.out! : join(ROOT, args.out!);
    writeTextFile(outPath, yamlText);
    console.log(`\nSaved candidates YAML to ${outPath}`);
  }
  if (!args.dryRun && candidates.length > 0) {
    writeTextFile(candidatePathResolved, formatCandidateRegistry(registry));
  }
  return 0;
}

export interface ReviewCliArgs {
  candidates?: string;
  limit?: number;
  now?: string | null;
}

export async function cmdReview(args: ReviewCliArgs): Promise<number> {
  const { runReviewCandidates } = await import("./review-candidates.ts");
  const rawPath = args.candidates ?? join(ROOT, "data", "discovered_candidates.yaml");
  const candidatesPath = isAbsolute(rawPath) ? rawPath : join(ROOT, rawPath);
  const limit = args.limit ?? 60;
  const now = args.now ? parseNow(args.now) : new Date();
  runReviewCandidates(candidatesPath, limit, now);
  return 0;
}

function writeTextFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

export interface CliArgs {
  command?: string;
  out?: string;
  candidateOut?: string | null;
  config?: string;
  offline?: boolean;
  now?: string | null;
  cache?: string;
  categories?: string | null;
  minYear?: number;
  dryRun?: boolean;
  append?: boolean;
  noEmbeddings?: boolean;
  candidates?: string;
  limit?: number;
  help?: boolean;
}

export function usage(): string {
  return [
    "usage: node src/cli.ts <command> [options]",
    "",
    "commands:",
    "  build    収集して public/ を生成する",
    "    -o, --out <dir>       出力先ディレクトリ (default: public)",
    "    -c, --config <path>   設定ファイル (default: config.yaml)",
    "    --offline             ネットワークを使わずキャッシュのみ使う",
    "    -n, --now <iso>       基準時刻。例 2026-08-09T00:00:00Z",
    "    --cache <dir>         上流 tarball のキャッシュ先 (default: .cache)",
    "    --no-embeddings       埋め込み (embeddings.json) を生成しない（テスト用・高速化）",
    "  discover 穴場の会議・ジャーナルを自律探索する",
    "    -o, --out <path>      出力YAMLパス（未指定時は標準出力表示）",
    "    --candidate-out <path> 候補ライフサイクル artifact (default: data/discovered_candidates.yaml)",
    "    --categories <s>      カンマ区切りの対象カテゴリ（例: hpc,systems）",
    `    -y, --min-year <n>    対象の最小年 (default: ${DEFAULT_MIN_YEAR})`,
    "    -d, --dry-run         ファイル出力せず結果をプレビュー表示",
    "    -a, --append          既存 YAML に key 重複なしで追記",
    "  review   探索された候補のレビュー順・重複・predatory 疑いを一覧表示する",
    "    -C, --candidates <p>  候補 YAML パス (default: data/discovered_candidates.yaml)",
    "    -l, --limit <n>       表示上限件数 (default: 60)",
    "    -n, --now <iso>       基準時刻。例 2026-08-09T00:00:00Z",
    "  help / --help / -h      使い方を表示する",
  ].join("\n");
}

// 有限正整数の文字列のみ数値化し、不正値・非数値は既定値にフォールバックする。
// Number("abc") = NaN になり、下流の `?? default` が NaN を拾わないため、
// 非数値入力が cand.year >= NaN（常に false）へ伝播して discover が 0 件になるのを防ぐ (#312)。
function toPosInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && Number.isInteger(n) && n > 0 ? n : fallback;
}

export function parseArgs(argv: string[] | null | undefined): CliArgs {
  const args: CliArgs = {};
  if (!argv || !Array.isArray(argv)) return args;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    let a = raw;
    let eqVal: string | undefined;
    const eqIdx = raw.indexOf("=");
    if (raw.startsWith("-") && eqIdx > 0) {
      a = raw.slice(0, eqIdx);
      eqVal = raw.slice(eqIdx + 1);
    }
    const nextVal = (): string | undefined => {
      if (eqVal !== undefined) return eqVal;
      const v = argv[i + 1];
      if (v !== undefined && !v.startsWith("-")) {
        i += 1;
        return v;
      }
      return undefined;
    };
    const boolVal = (): boolean => {
      if (eqVal === undefined) return true;
      const low = eqVal.toLowerCase();
      return low !== "false" && low !== "0" && low !== "no" && low !== "off";
    };

    if (a === "--help" || a === "-h" || a === "help") {
      args.help = true;
    } else if (a === "--out" || a === "-o") {
      args.out = nextVal() ?? "public";
    } else if (a === "--candidate-out") {
      args.candidateOut = nextVal() ?? join(ROOT, "data", "discovered_candidates.yaml");
    } else if (a === "--config" || a === "-c") {
      args.config = nextVal() ?? "config.yaml";
    } else if (a === "--cache") {
      args.cache = nextVal() ?? ".cache";
    } else if (a === "--now" || a === "-n") {
      args.now = nextVal() ?? null;
    } else if (a === "--categories") {
      args.categories = nextVal() ?? null;
    } else if (a === "--min-year" || a === "-y") {
      args.minYear = toPosInt(nextVal(), DEFAULT_MIN_YEAR);
    } else if (a === "--offline") {
      args.offline = boolVal();
    } else if (a === "--no-embeddings") {
      args.noEmbeddings = boolVal();
    } else if (a === "--dry-run" || a === "-d") {
      args.dryRun = boolVal();
    } else if (a === "--append" || a === "-a") {
      args.append = boolVal();
    } else if (a === "--candidates" || a === "-C") {
      args.candidates = nextVal() ?? join(ROOT, "data", "discovered_candidates.yaml");
    } else if (a === "--limit" || a === "-l") {
      args.limit = toPosInt(nextVal(), 60);
    } else if (a.startsWith("-")) {
      throw new Error(`unknown option: ${raw}`);
    } else {
      positional.push(raw);
    }
  }
  if (positional[0] === "help") {
    args.help = true;
  } else {
    args.command = positional[0];
  }
  return args;
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
  let args: CliArgs;
  try {
    const rest = extractArgvRest(argv);
    args = parseArgs(rest);
  } catch (exc) {
    process.stderr.write(`error: ${String(exc)}\n\n${usage()}\n`);
    return 2;
  }
  if (args.help) {
    console.log(usage());
    return 0;
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
      candidateOut: args.candidateOut ?? null,
      categories: args.categories ?? null,
      minYear: args.minYear ?? DEFAULT_MIN_YEAR,
      dryRun: Boolean(args.dryRun),
      append: Boolean(args.append),
    });
  }
  if (args.command === "review") {
    return cmdReview({
      candidates: args.candidates,
      limit: args.limit,
      now: args.now,
    });
  }
  process.stderr.write(`${usage()}\n`);
  return 2;
}

const isMain = Boolean(
  process.argv[1] && (process.argv[1].endsWith("cli.ts") || process.argv[1].endsWith("cli.js")),
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
