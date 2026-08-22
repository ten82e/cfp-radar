/**
 * Verified-observation stage between primary extraction and merge (#504).
 *
 * data/primary_overrides.yaml は一次ソースからの自動抽出「観測」を載せる。
 * 観測が確定締切 (at_utc 持ちの Deadline) として公開されるのは、次のすべてを
 * 満たすときだけにする (#504 / SPEC §5):
 *
 *   1. 日付に壁時計の時刻 (HH:MM[:SS]) が伴う。日付のみの証拠からは時刻を
 *      捏造しない (旧挙動は 23:59 AoE を暗黙生成していた)。
 *   2. tz が resolveTzStatus で confirmed (AoE 等の固定オフセット・IANA 名)。
 *      CST/BST 等の曖昧略称は不確認として公開しない。
 *   3. 観測年が適用先 edition 年と一致する。ページ年の食い違い (過去版の残骸) は
 *      隔離して stderr 警告を出す (warning_counts 経由で health gate も見える)。
 *
 * 検証を通らない行は edition パッチから除外され、パッチ内の deadlines が空に
 * なった edition は deadlines キーごと消える。これにより applyOverrides はその
 * edition をメタデータのみパッチし、既存の確定値 (手書き overrides / 上流) が
 * 保持される。「検証失敗 → 前回値維持」が単一の合成点で完結する。
 *
 * 手訂正の救済経路は本モジュールの外にある: 値の訂正は手編集の
 * data/overrides.yaml (primary より先に適用され、検証を通った primary 行が無い
 * 場合に効く)、tz 未表記ページの補完は data/primary.yaml の tz ヒント
 * (公式が明記した場合のみ) が担う。primary_overrides.yaml 自体は自動生成なので
 * 手編集ブロックの機構は持たない (次回 --apply で消えるため)。
 */

import { type DeadlineKind, KINDS, resolveTzStatus, warn } from "../model.ts";

const TIME_RE = /\b(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?[Mm]\.?)?/;

/** 解決済み行: そのまま applyOverrides/deadlinesOf に渡せる YAML 行。 */
export type ResolvedRow = Record<string, unknown>;

export function editionYearOf(date: string): number {
  return Number(date.slice(0, 4));
}

/**
 * テキストから壁時計の時刻を抜き出して 'HH:MM:SS' に正規化する。
 * 12h 表記 (5:00 pm / 11:59 PM) は 24h に変換する。見つからない・範囲外なら
 * null (日付のみの証拠として扱う)。
 */
export function extractObservationTime(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = TIME_RE.exec(String(text).trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const sec = m[3] ? Number(m[3]) : 0;
  const ap = (m[4] ?? "").replace(/\./g, "").toLowerCase();
  if (min > 59 || sec > 59 || h > 23) return null;
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23) return null;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(min)}:${pad(sec)}`;
}

interface ObservationRow {
  kind: string;
  label: string;
  date: string;
  time: string | null;
  tzRaw: string;
  round: number;
  rest: Record<string, unknown>;
}

function toObservationRows(rows: unknown): ObservationRow[] {
  if (!Array.isArray(rows)) return [];
  const out: ObservationRow[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const rec = row as Record<string, unknown>;
    // date は 'YYYY-MM-DD' 単独か、時刻埋め込み ('YYYY-MM-DD HH:MM[:SS]' /
    // 'YYYY-MM-DD hh:mm am/pm') のどちらも受ける。旧生成物・手マージ由来の
    // 埋め込み形式でも時刻の有無を正しく判定するため (#504)。
    const dm =
      /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AaPp]\.?[Mm]\.)?)?)?$/.exec(
        String(rec.date ?? "").trim(),
      );
    if (!dm) continue;
    const date = dm[1];
    const kind = String(rec.kind ?? "paper");
    // 明示 time フィールドがあればそれを優先し、無ければ埋め込み時刻を使う。
    let time = typeof rec.time === "string" ? extractObservationTime(rec.time) : null;
    if (time === null && dm[2]) time = extractObservationTime(dm[2]);
    out.push({
      kind,
      label: String(rec.label ?? kind),
      date,
      time,
      tzRaw: String(rec.tz ?? ""),
      round: Number(rec.round ?? 1) || 1,
      rest: rec,
    });
  }
  return out;
}

/** 観測 1 行を確定締切行に解決する。検証を通らないなら null。 */
export function resolveObservation(row: ObservationRow, editionYear: number): ResolvedRow | null {
  if (!row.time) return null; // 日付のみ → 時刻を捏造しない
  if (resolveTzStatus(row.tzRaw).status !== "confirmed") return null; // 曖昧 tz
  if (Number.isFinite(editionYear) && editionYearOf(row.date) !== editionYear) return null; // 年不一致
  const out: ResolvedRow = {
    kind: (KINDS as readonly string[]).includes(row.kind) ? row.kind : "other",
    label: row.label,
    date: `${row.date} ${row.time}`,
    tz: row.tzRaw,
    round: row.round,
  };
  if (typeof row.rest.comment === "string" && row.rest.comment !== "") {
    out.comment = row.rest.comment;
  }
  return out;
}

/**
 * primary_overrides 全体を検証済み観測のみのパッチへ変換する。
 * 手編集ブロック (manual: true) は素通し。破損入力 ({} 等) は {} を返す。
 */
export function resolvePrimaryObservations(
  primary: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!primary || typeof primary !== "object") return {};
  const conferences = primary.conferences as Record<string, unknown> | undefined;
  if (!conferences || typeof conferences !== "object") return {};
  const outConferences: Record<string, unknown> = {};
  for (const [key, confPatch] of Object.entries(conferences)) {
    if (typeof confPatch !== "object" || confPatch === null) continue;
    const rec = confPatch as Record<string, unknown>;
    const editions = rec.editions as Record<string, unknown> | undefined;
    if (!editions || typeof editions !== "object") {
      outConferences[key] = confPatch;
      continue;
    }
    const outEditions: Record<string, unknown> = {};
    for (const [yearKey, editionPatch] of Object.entries(editions)) {
      if (typeof editionPatch !== "object" || editionPatch === null) continue;
      const ep = editionPatch as Record<string, unknown>;
      const editionYear = Number(yearKey);
      const rows = toObservationRows(ep.deadlines);
      if (rows.length === 0) {
        outEditions[yearKey] = ep;
        continue;
      }
      let ambiguous = 0;
      let yearMismatch = 0;
      const resolved: ResolvedRow[] = [];
      for (const row of rows) {
        const done = resolveObservation(row, editionYear);
        if (done !== null) {
          resolved.push(done);
        } else if (Number.isFinite(editionYear) && editionYearOf(row.date) !== editionYear) {
          yearMismatch += 1;
        } else {
          ambiguous += 1;
        }
      }
      if (resolved.length === 0) {
        // 検証を通る行が無い → deadlines キーを外して既存の確定値を保持する。
        if (yearMismatch > 0) {
          warn(
            `primary[${key}/${yearKey}]: quarantined ${yearMismatch} observation(s) ` +
              "(page year conflicts with edition year)",
          );
        }
        if (ambiguous > 0) {
          warn(
            `primary[${key}/${yearKey}]: dropped ${ambiguous} observation(s) ` +
              "(date-only evidence or unconfirmed timezone)",
          );
        }
        const { deadlines: _omit, ...rest } = ep;
        outEditions[yearKey] = rest;
        continue;
      }
      if (yearMismatch > 0 || ambiguous > 0) {
        warn(
          `primary[${key}/${yearKey}]: kept ${resolved.length}/${rows.length} observation(s), ` +
            `quarantined ${yearMismatch} year-conflict / ${ambiguous} unverifiable`,
        );
      }
      outEditions[yearKey] = { ...ep, deadlines: resolved };
    }
    outConferences[key] = { ...rec, editions: outEditions };
  }
  return { conferences: outConferences };
}

/** テスト補助: 種別の妥当性判定 (KINDS との突合)。 */
export function isKnownDeadlineKind(kind: string): kind is DeadlineKind {
  return (KINDS as readonly string[]).includes(kind);
}
