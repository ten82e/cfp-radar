interface SiteDeadline {
  kind: string;
  label?: string;
  utc: string;
  aoe?: string;
  round?: number;
}

interface SiteEdition {
  year: number;
  edition_id?: string;
  link?: string;
  place?: string;
  date_text?: string;
  event_start?: string | null;
  event_end?: string | null;
  estimated?: boolean;
  estimate?: {
    point_estimate: string;
    window_start: string;
    window_end: string;
  };
  deadlines?: SiteDeadline[];
}

interface SiteConference {
  key: string;
  title: string;
  full_name?: string;
  link?: string;
  categories?: string[];
  tags?: string[];
  rank?: Record<string, string>;
  editions?: SiteEdition[];
  papers?: string[];
}

interface SiteRow {
  conf: SiteConference;
  ed: SiteEdition;
  kind: string;
  est?: boolean;
  t: number;
  tLast?: number;
  cats: string[];
  tags: string[];
  rankPairs: string[];
  hay: string;
  dupLabel?: string;
  _boosted?: boolean;
  _match?: { agg?: Record<string, number>; venueHit?: boolean };
  _vocabScore?: number;
  _matchScore?: number;
  _fitLabel?: string;
  _lexicalRank?: number | null;
  _semanticRank?: number | null;
  _semScore?: number;
  _availability?: unknown;
}

interface SitePaperRecord {
  title: string;
  abstract?: string;
  keywords?: string;
  venue?: string;
}

interface SiteElement extends HTMLElement {
  value: string;
  checked: boolean;
  files: FileList | null;
}

interface SiteRecommendation {
  row: SiteRow;
  boosted?: boolean;
  match?: { agg?: Record<string, number>; venueHit?: boolean };
  fit: {
    score: number;
    lexicalScore: number;
    semanticScore: number;
    label?: string;
    lexicalRank?: number | null;
    semanticRank?: number | null;
  };
  availability?: unknown;
}

interface SiteRecommenderApi {
  buildNameIdf(conferences: SiteConference[]): Record<string, unknown>;
  embeddingProbeMatches(meta: unknown, vector: number[]): boolean;
  embeddingSetCompatible(embeddings: unknown, language: string): boolean;
  hasJapanese(text: string): boolean;
  queryText(lines: readonly unknown[]): string;
  matchVenueTag(venue: string, conferences: SiteConference[]): SiteConference[];
  autoDetectCats(lines: readonly unknown[]): string[];
  venueCategories(lines: readonly unknown[], rows: SiteRow[]): string[];
  journalRows(conferences: SiteConference[], now: number): SiteRow[];
  pastRepresentatives(rows: SiteRow[], now: number): SiteRow[];
  rankMatches(rankPairs: string[], grade: string): boolean;
  comparePapers(a: SiteRow, b: SiteRow, now: number): number;
  safeExternalUrl(value: unknown): string;
  pdfPaperRecord(metadata: unknown, pages: unknown[], fallbackText: string): SitePaperRecord;
  textPaperRecord(text: string, fallbackText: string): SitePaperRecord;
  parsePaperLines(text: string): SitePaperRecord[];
  contentWordCount(text: string): number;
  semanticScore(key: string, vector: number[], embeddings: Record<string, number[]>): number;
  blendVectors(left: number[], right: number[], weight: number): number[];
  setNameIdf(value: Record<string, unknown>): void;
  setPaperVecs(value: Record<string, number[][]> | null): void;
  venueRecommendations(
    rows: SiteRow[],
    lines: readonly unknown[],
    semanticScores: Record<string, number> | null,
    now: number,
    options?: Record<string, unknown>,
  ): SiteRecommendation[];
}

interface SiteCatalog {
  generated_at: string;
  sources: Array<Record<string, unknown>>;
  categories: Record<string, string>;
  conferences: SiteConference[];
}

interface PdfTextItem {
  str?: string;
  transform?: number[];
}

interface PdfPage {
  getTextContent(): Promise<{ items: PdfTextItem[] }>;
}

interface PdfDocument {
  numPages: number;
  getPage(page: number): Promise<PdfPage>;
  getMetadata(): Promise<{ info?: Record<string, unknown> }>;
}

interface PdfLoadingTask {
  promise: Promise<PdfDocument>;
  destroy?: () => void | Promise<void>;
}

interface PdfJsRuntime {
  version?: string;
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(options: { data: ArrayBuffer }): PdfLoadingTask;
}

interface Window {
  __KAMIYOBI_DATA__: SiteCatalog | null;
  Recommender?: SiteRecommenderApi;
  pdfjsLib?: PdfJsRuntime;
  applyPreset?: (type: string) => void;
  toggleSort?: (key: string | null) => void;
  openDrawer?: (row: unknown) => void;
  closeDrawer?: (event?: Event) => void;
  _prevFocus?: HTMLElement | null;
  _activeRef?: HTMLElement | null;
}
