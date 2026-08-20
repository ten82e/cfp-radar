/**
 * Embeddings generator and CLI tests.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  benchmarkEmbeddingCacheKey,
  benchmarkEmbeddingManifest,
  benchmarkProfileHash,
  EMBEDDING_MODEL,
  EMBEDDING_MULTI_MODEL,
  EMBEDDING_MULTI_REVISION,
  EMBEDDING_REVISION,
  EMBEDDING_RUNTIME_VERSION,
  embeddingBundleKey,
  embeddingManifest,
  embeddingProfileHash,
  main,
  profileTexts,
  serializeVenueProfileArtifact,
  VENUE_PAPERS,
  VENUE_PROFILE_ARTIFACT,
  validateVenueProfileArtifact,
  venuePapersAtCutoff,
  venuePapersHash,
} from "../src/embeddings.ts";

describe("profileTexts", () => {
  const confs = [
    {
      key: "sigcomm",
      title: "SIGCOMM",
      full_name: "ACM SIGCOMM Conference",
      categories: ["networking"],
      tags: ["network", "system"],
    },
    {
      key: "ipsj-dps",
      title: "DPS",
      full_name: "マルチメディア通信と分散処理研究会",
      categories: ["systems"],
      tags: ["domestic-jp"],
    },
    {
      key: "rtss",
      title: "RTSS",
      full_name: "IEEE Real-Time Systems Symposium",
      categories: ["systems"],
      tags: ["real-time"],
    },
    {
      key: "sosp",
      title: "SOSP",
      full_name: "ACM Symposium on Operating Systems Principles",
      categories: ["systems"],
      tags: ["os"],
    },
  ];

  const catNames: Record<string, string> = {
    networking: "Networking and Communications",
    systems: "Computer Systems and Architecture",
  };

  it("builds English profile texts with full category names and papers for non-skip conferences", () => {
    const en = profileTexts(confs, catNames, false);
    expect(en.keys).toEqual(["sigcomm", "ipsj-dps", "rtss", "sosp"]);

    // SIGCOMM: includes expanded category name
    expect(en.texts[0]).toContain("Networking and Communications");
    // Japanese keywords should NOT be in English profile
    expect(en.texts[1]).not.toContain("カーネル");

    // RTSS is in SKIP_EMB_KEYS -> no paper titles in profile text
    expect(en.texts[2]).not.toContain("Pesto");

    // SOSP has papers in VENUE_PAPERS -> papers are included in English profile
    expect(en.texts[3]).toContain("Pesto: Cooking up High Performance BFT Queries");
  });

  it("builds Multilingual profile texts with Japanese category keywords for Japanese conferences", () => {
    const multi = profileTexts(confs, catNames, true);
    expect(multi.keys).toEqual(["sigcomm", "ipsj-dps", "rtss", "sosp"]);

    // Japanese conference receives Japanese category keywords in multi mode
    expect(multi.texts[1]).toContain("カーネル");
    expect(multi.texts[1]).toContain("ストレージ");

    // English conferences do not receive Japanese keywords in multi mode
    expect(multi.texts[0]).not.toContain("カーネル");

    // Papers are excluded in multi mode for language separation
    expect(multi.texts[3]).not.toContain("Pesto: Cooking up High Performance BFT Queries");
  });

  it("handles null, undefined, invalid entries, and empty keys defensively", () => {
    expect(profileTexts(null)).toEqual({ keys: [], texts: [] });
    expect(profileTexts(undefined)).toEqual({ keys: [], texts: [] });
    expect(profileTexts([], null)).toEqual({ keys: [], texts: [] });

    const mixed = [
      null as any,
      undefined as any,
      {},
      { key: "" },
      { key: "   " },
      { key: "clean-conf", title: "Clean Conf", categories: ["hpc"] },
    ];
    const res = profileTexts(mixed, null);
    expect(res.keys).toEqual(["clean-conf"]);
    expect(res.texts[0]).toContain("Clean Conf");
    expect(res.texts[0]).toContain("hpc");
  });
});

describe("generated venue profile artifact", () => {
  it("is canonical, versioned, and hash-compatible with runtime profiles", () => {
    const artifactText = readFileSync(
      new URL("../data/venue-profiles.json", import.meta.url),
      "utf8",
    );
    const artifact = JSON.parse(artifactText) as {
      schema: number;
      profiles_hash: string;
      policy: { method: string; max_prototypes: number; source_year_max: number };
      profiles: Record<
        string,
        {
          papers: Array<{
            title: string;
            year: number;
            source: string;
            source_url: string;
            collected_at: string;
          }>;
          selection: { method: string; max_prototypes: number; source_year_max: number };
        }
      >;
    };
    expect(artifact.schema).toBe(2);
    expect(artifact.profiles_hash).toBe(venuePapersHash());
    expect(artifact).toEqual(VENUE_PROFILE_ARTIFACT);
    expect(
      Object.fromEntries(
        Object.entries(artifact.profiles).map(([key, profile]) => [
          key,
          profile.papers.map((paper: { title: string }) => paper.title),
        ]),
      ),
    ).toEqual(VENUE_PAPERS);
    expect(artifactText).toBe(serializeVenueProfileArtifact(artifact));
    expect(Object.keys(artifact.profiles)).toEqual([...Object.keys(artifact.profiles)].sort());
    expect(
      new Set(Object.values(artifact.profiles).map((profile) => JSON.stringify(profile.selection)))
        .size,
    ).toBe(1);
  });

  it("rejects malformed provenance and protects the full-artifact hash", () => {
    const artifact = JSON.parse(
      readFileSync(new URL("../data/venue-profiles.json", import.meta.url), "utf8"),
    );
    const changed = JSON.parse(JSON.stringify(artifact));
    changed.profiles.ches.papers[0].source_url = "https://example.test/changed";
    expect(() => validateVenueProfileArtifact(changed)).toThrow(/hash mismatch/);

    const mixed = JSON.parse(JSON.stringify(artifact));
    mixed.profiles.ches.selection.source_year_max -= 1;
    expect(() => serializeVenueProfileArtifact(mixed)).toThrow(/mixed|cutoff/);

    const future = JSON.parse(JSON.stringify(artifact));
    future.profiles.ches.papers[0].year = 2026;
    expect(() => serializeVenueProfileArtifact(future)).toThrow(/cutoff|future/);
  });
});

describe("recommendation bundle contract", () => {
  it("keeps benchmark profiles and manifest identities cutoff-bound", () => {
    const base = JSON.parse(JSON.stringify(VENUE_PROFILE_ARTIFACT)) as any;
    const future = JSON.parse(JSON.stringify(base)) as any;
    const profileKey = Object.keys(future.profiles)[0];
    future.profiles[profileKey].papers.push({
      title: "Future-only profile paper",
      year: 2026,
      source: "fixture",
      source_url: "https://example.test/future",
      collected_at: "2026-08-20T00:00:00Z",
    });
    expect(venuePapersAtCutoff(2024, future)[profileKey]).not.toContain(
      "Future-only profile paper",
    );
    const cutoffText = profileTexts(
      [{ key: profileKey, title: "", full_name: "", categories: [], tags: [] }],
      {},
      false,
      venuePapersAtCutoff(2024, future),
    ).texts[0];
    expect(cutoffText).not.toContain("Future-only profile paper");
    expect(benchmarkProfileHash(2024, base)).toBe(benchmarkProfileHash(2024, future));
    expect(benchmarkProfileHash(2024, base)).not.toBe(benchmarkProfileHash(2025, base));
    expect(benchmarkEmbeddingCacheKey(2024)).not.toBe(benchmarkEmbeddingCacheKey(2025));

    const manifest = benchmarkEmbeddingManifest(2024, ["rtss"]);
    expect(manifest).toMatchObject({
      schema: 1,
      runtime_version: EMBEDDING_RUNTIME_VERSION,
      profile_year_max: 2024,
      models: {
        en: { model: EMBEDDING_MODEL, revision: EMBEDDING_REVISION, dim: 384 },
        multi: { model: EMBEDDING_MULTI_MODEL, revision: EMBEDDING_MULTI_REVISION, dim: 384 },
      },
      paper_vecs: { keys: ["rtss"], dim: 384 },
    });
    expect(manifest.profile_hash_at_cutoff).toBe(benchmarkProfileHash(2024));
    expect(manifest.cache_key).toBe(benchmarkEmbeddingCacheKey(2024));
  });

  it("pins model revisions and derives a complete cache key", () => {
    expect(EMBEDDING_REVISION).toMatch(/^[0-9a-f]{40}$/);
    expect(EMBEDDING_MULTI_REVISION).toMatch(/^[0-9a-f]{40}$/);
    expect(EMBEDDING_REVISION).not.toBe("main");
    expect(EMBEDDING_MULTI_REVISION).not.toBe("main");
    const data = { categories: {}, conferences: [] };
    const manifest = embeddingManifest(data);
    expect(manifest.runtime_version).toBe(EMBEDDING_RUNTIME_VERSION);
    expect(manifest.models.en).toMatchObject({
      model: EMBEDDING_MODEL,
      revision: EMBEDDING_REVISION,
    });
    expect(manifest.models.multi).toMatchObject({
      model: EMBEDDING_MULTI_MODEL,
      revision: EMBEDDING_MULTI_REVISION,
    });
    expect(embeddingBundleKey(embeddingProfileHash(data))).toBe(
      [
        "kamiyobi-recommendation",
        embeddingProfileHash(data),
        EMBEDDING_REVISION,
        EMBEDDING_MULTI_REVISION,
        EMBEDDING_RUNTIME_VERSION,
      ].join("-"),
    );
  });

  it("promotes generated JSON through a temporary file and rename", () => {
    const source = readFileSync(new URL("../src/embeddings.ts", import.meta.url), "utf8");
    const dollar = String.fromCharCode(36);
    expect(source).toContain(`const tempPath = \`${dollar}{outPath}.tmp.${dollar}{process.pid}\`;`);
    expect(source).toContain("renameSync(tempPath, outPath);");
  });
});

describe("embeddings CLI main", () => {
  it("returns 0 for --help, -h, help", async () => {
    expect(await main(["node", "embeddings.ts", "--help"])).toBe(0);
    expect(await main(["node", "embeddings.ts", "-h"])).toBe(0);
    expect(await main(["node", "embeddings.ts", "help"])).toBe(0);
  });

  it("returns 2 for wrong number of arguments and handles null/undefined safely", async () => {
    expect(await main(null)).toBe(2);
    expect(await main(undefined)).toBe(2);
    expect(await main(["node", "embeddings.ts"])).toBe(2);
    expect(await main(["node", "embeddings.ts", "one"])).toBe(2);
    expect(await main(["node", "embeddings.ts", "one", "two", "three"])).toBe(2);
    expect(await main(["only-one"])).toBe(2);
  });

  it("returns 1 when data file does not exist", async () => {
    expect(
      await main(["node", "embeddings.ts", "/tmp/nonexistent-data-12345.json", "/tmp/out.json"]),
    ).toBe(1);
    expect(await main(["/tmp/nonexistent-data-12345.json", "/tmp/out.json"])).toBe(1);
  });
});
