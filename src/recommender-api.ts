/** Typed boundary shared by the static site runtime and benchmark. */

export interface PaperLine {
  title: string;
  keywords?: string;
  venue?: string;
  abstract?: string;
}

export interface VenueRecommendation {
  venueKey: string;
  fit: {
    score: number;
    lexicalScore: number;
    semanticScore: number;
  };
  [key: string]: unknown;
}

export interface RecommenderApi {
  STOPWORDS: Set<string>;
  GENERIC_PAPER_WORDS?: Set<string>;
  parsePaperLines(text: string): PaperLine[];
  breakdown(row: unknown, lines: readonly unknown[]): { score: number; [key: string]: unknown };
  semanticScore(key: string, vector: number[], embeddings: Record<string, number[]>): number;
  blendScore(vocab: number, semantic: number, options?: Record<string, unknown>): number;
  blendVectors(left: number[], right: number[], weight: number): number[];
  contentWordCount(text: string): number;
  englishRatio(row: unknown): number;
  setExpandEnabled(enabled: boolean): void;
  setNameIdf(value: Record<string, unknown>): void;
  setPaperVecs(value: Record<string, number[][]> | null): void;
  setSigWeights(value: Record<string, number | boolean>): void;
  venueRecommendations(
    rows: unknown[],
    lines: readonly unknown[],
    semanticScores: Record<string, number>,
    now: number,
    options?: Record<string, unknown>,
  ): VenueRecommendation[];
}

export async function loadRecommender(): Promise<RecommenderApi> {
  await import("../site/recommender.js");
  const api = (globalThis as { Recommender?: RecommenderApi }).Recommender;
  if (!api) throw new Error("site recommender runtime did not initialize");
  return api;
}
