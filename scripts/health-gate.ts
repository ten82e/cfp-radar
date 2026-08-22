import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { evaluateHealthGate, type HealthReport } from "../src/build.ts";

export interface HealthGateArgs {
  currentPath: string;
  previousPath?: string;
  lastKnownGoodPath?: string;
  requireBaseline: boolean;
}

function usage(): never {
  console.error(
    [
      "usage: node scripts/health-gate.ts <current-health.json>",
      "  [--require-baseline]",
      "  [last-known-good.json] [write-last-known-good.json]",
    ].join(" "),
  );
  process.exit(2);
}

export function parseHealthGateArgs(argv: string[]): HealthGateArgs | null {
  const positional: string[] = [];
  let requireBaseline = false;
  for (const arg of argv) {
    if (arg === "--require-baseline") {
      requireBaseline = true;
      continue;
    }
    positional.push(arg);
  }
  if (positional.length === 0 || positional.length > 3) return null;
  return {
    currentPath: positional[0],
    ...(positional[1] ? { previousPath: positional[1] } : {}),
    ...(positional[2] ? { lastKnownGoodPath: positional[2] } : {}),
    requireBaseline,
  };
}

export function runHealthGate(argv: string[]): number {
  const args = parseHealthGateArgs(argv);
  if (!args) usage();
  const hasUsableBaseline = Boolean(args.previousPath && existsSync(args.previousPath));
  if (args.requireBaseline && !hasUsableBaseline) {
    console.error("health gate blocked deployment: usable baseline is unavailable");
    return 1;
  }
  try {
    const currentText = readFileSync(args.currentPath, "utf8");
    const current = JSON.parse(currentText) as HealthReport;
    const previous = hasUsableBaseline
      ? (JSON.parse(readFileSync(args.previousPath!, "utf8")) as HealthReport)
      : null;
    const result = evaluateHealthGate(current, previous);
    if (!result.ok) {
      console.error(`health gate blocked deployment: ${result.reasons.join("; ")}`);
      return 1;
    }
    if (args.lastKnownGoodPath) {
      writeFileSync(args.lastKnownGoodPath, `${JSON.stringify(current, null, 2)}\n`);
    }
    console.log(
      previous
        ? "health gate passed against last-known-good"
        : "health gate passed without baseline",
    );
    return 0;
  } catch (error) {
    console.error(`health gate could not read its report: ${String(error)}`);
    return 1;
  }
}

const isMain = process.argv[1]?.endsWith("health-gate.ts");
if (isMain) process.exit(runHealthGate(process.argv.slice(2)));
