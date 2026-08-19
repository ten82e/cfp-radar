import { readFileSync, writeFileSync } from "node:fs";

import { serializeVenueProfileArtifact } from "../src/embeddings.ts";

const [inputPath, outputPath] = process.argv.slice(2);

if (!inputPath || !outputPath) {
  console.error("usage: node scripts/generate-venue-profiles.ts <input.json> <output.json>");
  process.exitCode = 2;
} else {
  const input = JSON.parse(readFileSync(inputPath, "utf8"));
  writeFileSync(outputPath, serializeVenueProfileArtifact(input));
}
