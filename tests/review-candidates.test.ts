import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/review-candidates.ts";

// #312/#302続編 と同型: --limit の不正値が下流 future.slice(0, limit) で
// 末尾切り捨て＋誤ヘッダ「上位 -3 件」になるのを防ぐ。
describe("review-candidates parseArgs --limit のフォールバック", () => {
  it("負・非整数・非数値・0 を既定値 60 へ、正整数は保持", () => {
    expect(parseArgs(["--limit=-3"]).limit).toBe(60);
    expect(parseArgs(["-l", "-1"]).limit).toBe(60);
    expect(parseArgs(["--limit=abc"]).limit).toBe(60);
    expect(parseArgs(["--limit=1.5"]).limit).toBe(60);
    expect(parseArgs(["--limit=0"]).limit).toBe(60);
    expect(parseArgs(["--limit=10"]).limit).toBe(10);
    expect(parseArgs([]).limit).toBe(60);
  });
});
