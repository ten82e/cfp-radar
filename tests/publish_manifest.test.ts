import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writePublishManifest } from "../src/build.ts";
import {
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
  EMBEDDING_MULTI_MODEL,
  embeddingManifest,
  venuePapersHash,
} from "../src/embeddings.ts";
import { NOW, runCli } from "./helpers.ts";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

describe("publish manifest", () => {
  it("hashes final artifacts deterministically and excludes the manifest itself", () => {
    const outdir = mkdtempSync(join(tmpdir(), "kamiyobi-publish-"));
    const files = ["b.txt", "a.txt"];
    for (const [name, text] of [
      ["a.txt", "alpha"],
      ["b.txt", "beta"],
    ] as const) {
      writeFileSync(join(outdir, name), text, "utf8");
    }

    const first = writePublishManifest(outdir, files, NOW, "lexical-only");
    const firstText = readFileSync(join(outdir, "publish.json"), "utf8");
    const secondText = (() => {
      writePublishManifest(outdir, ["a.txt", "b.txt", "publish.json"], NOW, "lexical-only");
      return readFileSync(join(outdir, "publish.json"), "utf8");
    })();

    expect(first).toEqual({
      schema_version: 1,
      generated_at: "2026-08-09T00:00:00.000Z",
      semantic_status: "lexical-only",
      artifacts: {
        "a.txt": { bytes: 5, sha256: sha256("alpha") },
        "b.txt": { bytes: 4, sha256: sha256("beta") },
      },
    });
    expect(firstText).toBe(secondText);
  });

  it("distinguishes a lexical-only build from a restored embedding bundle", () => {
    const outdir = join(mkdtempSync(join(tmpdir(), "kamiyobi-site-")), "public");
    const run = runCli(outdir, { extra: ["--no-embeddings"] });
    expect(
      run.status,
      `cli build failed\n--- stdout ---\n${run.stdout}\n--- stderr ---\n${run.stderr}`,
    ).toBe(0);

    const lexicalManifest = JSON.parse(readFileSync(join(outdir, "publish.json"), "utf8")) as {
      generated_at: string;
      semantic_status: string;
      artifacts: Record<string, { sha256: string }>;
    };
    expect(lexicalManifest.semantic_status).toBe("lexical-only");
    expect(lexicalManifest.artifacts["data.json"]).toBeDefined();
    expect(lexicalManifest.artifacts.embeddings).toBeUndefined();
    const preRestoreHashes = JSON.stringify(lexicalManifest.artifacts);

    // CI cache restore writes this production-shaped bundle after --no-embeddings build.
    const data = JSON.parse(readFileSync(join(outdir, "data.json"), "utf8")) as {
      categories: Record<string, string>;
      conferences: Array<Record<string, unknown>>;
    };
    const probe = new Array<number>(EMBEDDING_DIM).fill(0);
    const embeddingBundle = {
      model: EMBEDDING_MODEL,
      dim: EMBEDDING_DIM,
      venuePapersHash: venuePapersHash(),
      manifest: embeddingManifest(data),
      embeddings: Object.fromEntries(embeddingManifest(data).keys.map((key) => [key, [...probe]])),
      multi: {
        model: EMBEDDING_MULTI_MODEL,
        dim: EMBEDDING_DIM,
        embeddings: Object.fromEntries(
          embeddingManifest(data).keys.map((key) => [key, [...probe]]),
        ),
      },
      paperVecs: {},
    };
    writeFileSync(join(outdir, "embeddings.json"), JSON.stringify(embeddingBundle), "utf8");

    const readyManifest = writePublishManifest(
      outdir,
      ["data.json", "embeddings.json"],
      new Date(lexicalManifest.generated_at),
      "ready",
    );
    expect(existsSync(join(outdir, "embeddings.json"))).toBe(true);
    expect(readyManifest.semantic_status).toBe("ready");
    expect(JSON.stringify(readyManifest.artifacts)).not.toBe(preRestoreHashes);
    expect(readyManifest.artifacts["embeddings.json"]?.sha256).toBe(
      createHash("sha256")
        .update(readFileSync(join(outdir, "embeddings.json")))
        .digest("hex"),
    );
  });

  it("keeps final publish-manifest generation after recommendation restoration in CI", () => {
    const workflow = readFileSync(
      new URL("../.github/workflows/update.yml", import.meta.url),
      "utf8",
    );
    const validateAt = workflow.indexOf("name: Validate recommendation bundle");
    const saveAt = workflow.indexOf("name: Save recommendation bundle");
    const manifestAt = workflow.indexOf("name: Write final publish manifest");
    const uploadAt = workflow.indexOf("name: Upload Pages artifact");
    expect([validateAt, saveAt, manifestAt, uploadAt].every((value) => value >= 0)).toBe(true);
    expect(saveAt).toBeLessThan(manifestAt);
    expect(manifestAt).toBeLessThan(uploadAt);
    expect(workflow.slice(manifestAt, uploadAt)).toContain('existsSync("public/embeddings.json")');
    expect(workflow.slice(manifestAt, uploadAt)).toContain("writePublishManifest");
  });
});
