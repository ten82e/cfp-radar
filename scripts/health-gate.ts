import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { evaluateHealthGate, type HealthReport } from "../src/build.ts";

const [currentPath, previousPath, lastKnownGoodPath] = process.argv.slice(2);
if (!currentPath) {
  console.error(
    "usage: node scripts/health-gate.ts <current-health.json> [last-known-good.json] [write-last-known-good.json]",
  );
  process.exit(2);
}

try {
  const currentText = readFileSync(currentPath, "utf8");
  const current = JSON.parse(currentText) as HealthReport;
  const previous =
    previousPath && existsSync(previousPath)
      ? (JSON.parse(readFileSync(previousPath, "utf8")) as HealthReport)
      : null;
  const result = evaluateHealthGate(current, previous);
  if (!result.ok) {
    console.error(`health gate blocked deployment: ${result.reasons.join("; ")}`);
    process.exit(1);
  }
  if (lastKnownGoodPath) writeFileSync(lastKnownGoodPath, `${JSON.stringify(current, null, 2)}\n`);
  console.log(
    previous ? "health gate passed against last-known-good" : "health gate passed without baseline",
  );
} catch (error) {
  console.error(`health gate could not read its report: ${String(error)}`);
  process.exit(1);
}
