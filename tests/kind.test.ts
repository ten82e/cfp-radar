/**
 * kind_of: SPEC.md section 3.3, against the upstream type names listed in 1.1 / 1.2.
 * Ported from tests/test_kind.py.
 */

import { describe, expect, it } from "vitest";
import { KINDS, kindOf } from "../src/model.ts";

const KINDS_SET = new Set(KINDS);

// A transcription of the SPEC.md 3.3 table.
const SPEC_TABLE: Array<[string, string]> = [
  ["deadline", "paper"],
  ["paper", "paper"],
  ["submission", "paper"],
  ["full_paper", "paper"],
  ["abstract_deadline", "abstract"],
  ["abstract deadline", "abstract"],
  ["abstract", "abstract"],
  ["supplementary", "supplementary"],
  ["notification", "notification"],
  ["first-notification", "notification"],
  ["final-notification", "notification"],
  ["camera_ready", "camera_ready"],
  ["camera-ready", "camera_ready"],
  ["revision-deadline", "camera_ready"],
  ["rebuttal_start", "rebuttal_start"],
  ["rebuttal_end", "rebuttal_end"],
  ["rebuttal", "rebuttal_end"],
  ["rebuttal_and_revision", "rebuttal_end"],
  ["author_response", "rebuttal_end"],
  ["review_release", "review_release"],
  ["registration", "registration"],
  ["reviewer_registration", "registration"],
  ["commitment_deadline", "registration"],
  ["withdrawal", "other"],
];

const UPSTREAM_TYPES = SPEC_TABLE.map(([raw]) => raw);

describe("kind_of", () => {
  it.each(UPSTREAM_TYPES)("every upstream type %s maps into the ten kinds", (raw) => {
    expect(KINDS_SET.has(kindOf(raw))).toBe(true);
  });

  it.each(SPEC_TABLE)("explicit mapping %s -> %s", (raw, expected) => {
    expect(kindOf(raw)).toBe(expected);
  });

  it("ccfddl main deadline key is a paper deadline", () => {
    expect(kindOf("deadline")).toBe("paper");
  });

  it("supplementary is not collapsed into paper", () => {
    expect(kindOf("supplementary")).toBe("supplementary");
    expect(kindOf("supplementary")).not.toBe(kindOf("paper"));
  });

  it("rebuttal start and end are distinct", () => {
    expect(kindOf("rebuttal_start")).not.toBe(kindOf("rebuttal_end"));
    expect(["rebuttal_start", "rebuttal_end"]).not.toContain(kindOf("review_release"));
  });

  it.each(["withdrawal", "banquet", "", "something-else"])(
    "unmapped types %j fall back to other",
    (raw) => {
      expect(kindOf(raw)).toBe("other");
    },
  );

  it("mapping is total and pure", () => {
    for (const raw of [...UPSTREAM_TYPES, "???", "PAPER"]) {
      expect(kindOf(raw)).toBe(kindOf(raw));
      expect(KINDS_SET.has(kindOf(raw))).toBe(true);
    }
  });

  it("declared kinds match the spec table", () => {
    expect(KINDS_SET).toEqual(
      new Set([
        "abstract",
        "paper",
        "supplementary",
        "notification",
        "camera_ready",
        "rebuttal_start",
        "rebuttal_end",
        "review_release",
        "registration",
        "other",
      ]),
    );
  });
});
