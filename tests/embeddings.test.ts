/**
 * Embeddings generator and CLI tests.
 */

import { describe, expect, it } from "vitest";
import { main, profileTexts } from "../src/embeddings.ts";

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

describe("embeddings CLI main", () => {
  it("returns 0 for --help, -h, help", async () => {
    expect(await main(["node", "embeddings.ts", "--help"])).toBe(0);
    expect(await main(["node", "embeddings.ts", "-h"])).toBe(0);
    expect(await main(["node", "embeddings.ts", "help"])).toBe(0);
  });

  it("returns 2 for wrong number of arguments", async () => {
    expect(await main(["node", "embeddings.ts"])).toBe(2);
    expect(await main(["node", "embeddings.ts", "one"])).toBe(2);
    expect(await main(["node", "embeddings.ts", "one", "two", "three"])).toBe(2);
  });

  it("returns 1 when data file does not exist", async () => {
    expect(
      await main(["node", "embeddings.ts", "/tmp/nonexistent-data-12345.json", "/tmp/out.json"]),
    ).toBe(1);
  });
});
