# kamiyobi 設計仕様（実装の正）

HPC・ネットワーク・システム・AI 系会議の投稿締切と開催日を、GitHub Actions だけで
日次に自動収集し、JSON / CSV / Markdown / 静的サイトとして公開する。
サーバも外部サービスも使わない。GitHub 内で完結する。

この文書は実装の契約である。ここに書かれた型・関数シグネチャ・ファイル分担から逸脱しない。
プロジェクト名は kamiyobi（旧称 conf-deadlines / cfp-radar）。

## 0. 改訂

**rev.2（反証レビュー反映済み）。rev.1 を読んで実装を始めた担当は、本書を読み直すこと。**
rev.1 には実データ走査で確認された欠陥が 30 件あった。主要な修正:

- `kind_of` に ccfddl の主キー `deadline` の規則が無く、本文締切 1591 件が `other` に落ちていた（§3）
- `edition_id` が上流で一意でない（`ica3pp` が 4 版で同一、`fse23`〜`fse26` が別会議で重複）。
- 突き合わせキー `(year, round, kind)` で hf の締切 473 件中 127 件が消えていた（§3）
- `slug(title)` が別会議を潰す組が実在（`FSE` × 2、`SEC` × 2）。曖昧性解消表を導入（§3, §5）
- rank_filter で HotNets・APNet が落ち、MX 分野（MLSys, RTSS, EMSOFT）が丸ごと落ちていた（§5）
- venue の綴りが実データと不一致（`atc` → `sigops-atc`、`europar` → `euro-par`）（§5）
- **MLSys は上流 ccfddl の `MX/mlsys.yml` に実在する。** extra.yaml に重複登録しない（§5）
- snapshot からの復旧経路が §3 に存在せず、§6 の障害耐性が実現不能だった（§3, §6）
- サイトへの差し込みマーカーが 2 通り書かれていた（§7）

**rev.11（§2 scripts）。** `scripts/compare-head.ts` は update.yml の実質差分検出。
分担ツリーに足す（#380）。

**rev.10（§2 ツリー）。** 実リポジトリにある `site/recommender.js`・
`src/bench-recommender.ts`・`data/primary.yaml`・`data/primary_overrides.yaml`・
`data/discovered_candidates.yaml` を分担ツリーへ足す（#378）。

**rev.9（§3.7 CLI）。** §3.7 が `build` だけを書いていた。実装の `usage()` は
`discover` / `review` と `build --no-embeddings` を持つ。README は #239/#243/#247
で同期済み。SPEC を実装の正に戻す（#374）。

**rev.8（§8 の開催行契約）。** §8 の `build_golden.test.ts` 行が、rev.4 以前の
「開催回が index.html に届いている」を残していた。実装固定は
`index.html has no meeting rows`。開催日は `upcoming.md`（#372）。

**rev.7（推薦 CDN の例外）。** §7 の「外部 CDN・依存ライブラリなし」はコア UI
（表・絞り込み・システムフォント）に限る。§10 の推薦は sibling の
`recommender.js` と、任意の CDN 遅延ロード（transformers.js / pdf.js）を使う。
未接続時は語彙スコアと TXT 入力へフォールバックする（#370）。

**rev.6（upcoming.md の窓を設定可能に）。** `config.yaml` の `site.upcoming_days`
（既定 180）を `upcoming.md` の窓として実際に読むようにした。宣言のみで読まれず
常に 180 日で固定されていた契約バグ（#95）を解消し、`llms.txt` の説明も同じ値に
合わせた（§4）。実装・テスト固定は `src/build.ts` と `tests/build_golden.test.ts`。

**rev.5（UI 期間窓の契約整合）。** 「締切直近 (7日以内)」プリセットがラベルと
裏腹に 30 日窓（`win=30d`）で動作していた不一致（`9bbeabf` 由来）を解消し、
7 日窓（`win=7d`）を期間ドロップダウンに追加した（§7）。実装・テスト固定は
`site/template.html` と `tests/build_golden.test.ts`。

**rev.4（契約整合）。** 2026-08-10 のサイト狭小化（`c85fe0a`）後も未更新だった
SPEC §7 を実装・テスト固定（`tests/build_golden.test.ts`「index.html has no meeting rows」）
と整合させた。

- サイト表は投稿締切（概要・論文）のみ表示し、開催・採否通知・カメラレディ等の行を
  出さない（§7）。開催日は `upcoming.md`（§4）で配信する
- 開催行の過去判定（終了日 + 1 日）・残り日数表示の規則は `upcoming.md` 側（§4）に
  定めるものとし、§7 からはその参照に改めた

**rev.3（生成物の実測レビュー反映済み）。** rev.2 の規則のうち、生成物を実測して
誤りが確認されたものを直した。

- 締切の重複統合が源を区別せず一律 3600 秒だった。源をまたぐ食い違いは 24 時間まで
  分布する一方、同一源の同時刻 2 件は別トラックのことがある。規則を源ごとに分けた（§3.6）
- 統合時の `round` を優先源から採っていたため、round の概念が無い aideadlines が
  ccfddl の round 2 を潰していた（実測 11 件）。源をまたぐときは大きい方を採る（§3.6）
- `rollforward` の後に統合が走らず、残った重複が推定版へ複製されていた（§3.6）
- 開催回の過去判定が開始日だったため、会期初日から最終日まで一覧から消えていた。
  終了日 + 1 日で判定する（§7）
- `upcoming.md` に開催回が 1 行も無かった（§4）

---

## 1. データ源（実データ全件走査で検証済み・2026-08-09 時点）

| 名前 | リポジトリ | ライセンス | 形状 |
|---|---|---|---|
| `ccfddl` | `ccfddl/ccf-deadlines` (main) | MIT | `conference/**/*.yml` **353 本 / 1150 版** |
| `aideadlines` | `huggingface/ai-deadlines` (main) | MIT | `src/data/conferences/*.yml` 68 本 / 122 版 |
| `local` | 本リポジトリ `data/extra.yaml` | - | 上流が扱わない会議 |

取得方法は **tarball 一括ダウンロード**（`https://codeload.github.com/<repo>/tar.gz/refs/heads/main`）。
Git API のファイル単位取得はレート制限に当たるので使わない。

### 1.1 ccfddl のスキーマ（実データから確認済み）

```yaml
- title: SIGCOMM
  description: ACM International Conference on ...   # = full_name
  sub: NW                                            # AI CG CT DB DS HI MX NW SC SE
  rank: {ccf: A, core: A*, thcpl: A}
  dblp: sigcomm
  confs:
    - year: 2026
      id: sigcomm26
      link: https://...
      timeline:
        - abstract_deadline: '2026-01-30 23:59:59'   # 任意
          deadline: '2026-02-06 23:59:59'            # 必須
          comment: '...'                             # 任意
      timezone: AoE
      date: August 17 - 21, 2026                     # 自由文
      place: Denver, Colorado, USA
```

**確認済みの罠（実測値つき。推測ではない）**

1. **再帰探索が必要**。`conference/*/*.yml` の 1 階層グロブでは `conference/DB/pods/pods.yml`
   を取りこぼす。`conference/**/*.yml` で辿り、`conference/types.yml`（分野定義であり
   会議ファイルではない）を除外する。結果は 353 本 / 1150 版。
2. `timeline` は配列で **複数ラウンドあり**（NSDI は年 2 回）。
   ただし **timeline は締切昇順とは限らない**（`sac26`・`issre23` で逆順）。
   配列添字で会議を識別しない。
3. **キー `abstract deadline`（空白入り）が実データにちょうど 1 件**存在する。
   `abstract_deadline` と同義に扱う。
4. **本文締切のキー名は `deadline`**（1591 件）。`kind_of` はこれを `paper` に落とすこと。
   ここを落とすと本文締切が全滅する。
5. `timezone` の実在値は 19 種（全件一致を確認）:
   `AoE`(622) `UTC-12`(216) `UTC-8`(59) `UTC+0`(55) `UTC-7`(44) `UTC`(40) `UTC+8`(29)
   `UTC-5`(28) `UTC-4`(23) `PT`(10) `UTC+1`(7) `UTC+7`(3) `UTC+10`(3) `UTC+2`(2)
   `UTC+3`(2) `UTC-10`(2) `UTC-11`(2) `UTC-6`(1) `UTC+9`(1)。
   `PT` は固定オフセットにしてはならない。VLDB は毎月 1 日の締切を持ち夏時間境界をまたぐ。
6. `date` は自由文。構造化された開始終了日は **無い**。実在形状の上位:
   `July 20-23, 2026` / `September 29 - October 3, 2025` / `Oct 12-16, 2025` /
   `June 28 - July 2, 2026`。
   §3 の 6 例をそのまま正規表現化した厳密版で **96.4%**、月略記の `.`・en dash・`Sept`
   を許した寛容版で **97.4%** が構造化できることを実測済み（rev.2）。rev.4（2026-08-09）で月のみ（`November, 2026`）・月範囲（`March-April, 2025`）・括弧内 TBD 注記・`Septemper` typo を追加し、実測 **99.4%**（1143/1150、残 7 件は TBD/TBA/年のみ）。目標は 95% 以上。
7. 非日付は `deadline` に `TBD` が 4 件、`date` に `TBD` が 3 件（`cgo2027` `iss25` `sp27`）。
   パース失敗はスキップし警告を出す（例外にしない）。
   `confs` 空・`timeline` 空・`deadline` 欠落・不正日付形式は 0 件。
8. **`id`（edition_id）は一意でない。** 重複 5 種を実測:
   `ica3pp` は 2022/2023/2025/2026 の 4 版すべてが同じ `id: ica3pp`（年が入っていない）。
   `fse23` `fse24` `fse25` `fse26` は `SC/fse.yml`（Fast Software Encryption）と
   `SE/fse.yml`（Foundations of Software Engineering）という **別会議**が同じ id を使う。
   `edition_id` は表示用であり、会議の識別には使わない。
9. `year` と `date` の年がずれる版がある（`ICA3PP 2023` は `date: 'October 20-22, 2022'`）。
   `parse_date_range` は date 中の明示年を優先するので、開催日が過去年になる。許容する。
10. rank 値 `'N'` はランク無しの意味（`ccf: N` 33 件、`core: N` 78 件）。
    `core` キー自体の欠落が 3 件（`codes-isss` `hipeac` `performance`）。
    §5 の rank_filter は `'N'` を「該当ランク無し」として扱い、通過条件に数えない。

### 1.2 huggingface/ai-deadlines のスキーマ（実データから確認済み）

```yaml
- title: NeurIPS
  year: 2026
  id: neurips26
  full_name: Conference on Neural Information Processing Systems
  link: https://neurips.cc/
  deadlines:
    - {type: abstract, label: '...', date: '2026-05-04 23:59:59', timezone: AoE}
    - {type: paper,    label: '...', date: '2026-05-06 23:59:59', timezone: AoE}
  date: December 6-12, 2026
  start: '2026-12-06'      # 構造化。113/122 版に存在
  end: '2026-12-12'
  city: Sydney
  country: Australia
  era_rating: a
  rankings: 'CCF: A, CORE: A*, THCPL: A'   # 自由文字列。構造化 dict ではない
  tags: [machine-learning]
```

**確認済みの罠（実測値つき）**

1. **旧形式は 13 版**（`deadlines` キー自体を持たない）。うち 8 版がトップレベルに
   `deadline` / `abstract_deadline` / `timezone` を直に持つ。
2. **`cvpr26` は新旧両形式を併存させている**（`deadlines` 7 本 + トップレベル `deadline`）。
   **`deadlines` があるときはトップレベルの `deadline`/`abstract_deadline` を読まない。**
   両方読むと二重登録になる。
3. **締切を一切持たない版が 10 版**（うち 5 版は `deadlines: []` の空リスト）。
   開催イベントのみとして扱う。
4. `deadlines[]` に規定外キーが 1 件（`cec2025` が `date` と `deadline` の両方を持つ）。
   `date` を正とする。
5. `deadlines[].type` の実在値は 20 種:
   `abstract` `paper` `submission` `supplementary` `registration` `reviewer_registration`
   `commitment_deadline` `notification` `first-notification` `final-notification`
   `review_release` `rebuttal_start` `rebuttal_end` `rebuttal` `rebuttal_and_revision`
   `author_response` `withdrawal` `camera_ready` `camera-ready` `revision-deadline`。
6. `timezone` の実在値は 12 種: `AoE` `UTC` `UTC+0` `UTC-08`（ゼロ埋め） `UTC-8` `UTC-7`
   `UTC-5` `UTC+02` `GMT+02` `PST` `Europe/London` `Pacific/Honolulu`（IANA 名）。
7. **ccf/core の構造化ランクを持つ版は 0 / 122。** `rankings` は
   `'CCF: A, CORE: A*, THCPL: A'` という自由文字列（64 版）か `None`（58 版）。
   §3 の `parse_rankings` でこれを dict に落とす。
8. ファイルはリスト形式のこともスカラー（単一 dict）のこともある。両方受ける。
9. トップレベルに `rebuttal_period_end` `final_decision_date` `review_release_date` が
   各 2 件ある。**これらは読まない**（`deadlines` を持つ版にのみ現れる冗長データ）。
10. `date`/`start`/`end` が全て無い版が 1 件（`eurographics27`）。

---

## 2. ディレクトリ構成とファイル分担

```
kamiyobi/
├── SPEC.md                      # 本書
├── README.md                    # 利用手順（手書き。自動更新しない）      [担当E]
├── LICENSE                      # MIT                                    [担当E]
├── NOTICE.md                    # 上流 MIT の帰属表示                     [担当E]
├── package.json                 # 依存・スクリプト (npm test / build)     [担当E]
├── tsconfig.json                # TS 設定                                [担当E]
├── biome.json                   # lint/format                            [担当E]
├── config.yaml                  # 収録範囲・カテゴリ定義                [担当B]
├── data/
│   ├── extra.yaml               # 上流に無い会議                          [担当B]
│   ├── overrides.yaml           # 上流の訂正・別名・カテゴリ上書き        [担当B]
│   ├── primary.yaml             # 一次ソース URL 一覧                     [担当E]
│   ├── primary_overrides.yaml   # 一次ソース抽出結果（自動）              [自動]
│   ├── discovered_candidates.yaml # discover の既定出力                   [担当G]
│   └── snapshot.json            # 生成物(コミットされる。上流障害時の退避) [自動]
├── src/
│   ├── model.ts                 # 型・時刻解決・日付パーサ・snapshot 入出力 [担当A]
│   ├── sources/
│   │   ├── base.ts              #                                        [担当A]
│   │   ├── ccfddl.ts            #                                        [担当A]
│   │   ├── aideadlines.ts       #                                        [担当A]
│   │   └── local.ts             # data/extra.yaml 読み込み                [担当A]
│   ├── merge.ts                 # 名寄せ・分類・上書き・推定              [担当B]
│   ├── discover.ts              # 穴場会議・ジャーナル自律探索           [担当G]
│   ├── fetch-primary.ts         # 一次ソース自動抽出                     [担当E]
│   ├── review-candidates.ts     # 候補レビュー支援                       [担当G]
│   ├── recommender-api.ts       # 推薦ランタイムの型境界                 [担当C]
│   ├── embeddings.ts            # 埋め込み生成                           [担当C]
│   ├── bench-recommender.ts            # 推薦ベンチ                             [担当C]
│   ├── build.ts                 # JSON/CSV/MD/llms.txt/HTML 出力          [担当C]
│   └── cli.ts                   # エントリポイント                        [担当C]
├── site/
│   ├── tsconfig.json             # ブラウザ runtime の checkJs 設定         [担当D]
│   ├── template.html            # コア UI（表・絞り込み。外部 CDN なし）  [担当D]
│   ├── app.js                   # 型検査対象のブラウザUI runtime       [担当D]
│   ├── recommender.js           # 論文推薦（§10。任意 CDN）              [担当D]
│   ├── recommender.d.ts         # 推薦ランタイムのグローバル型宣言       [担当C]
│   └── runtime.d.ts             # ブラウザ・生成データの型境界           [担当D]
├── scripts/
│   ├── compare-head.ts          # snapshot / primary_overrides の実質差分 [担当E]
│   ├── health-gate.ts           # last-known-good との配信前健全性ゲート [担当E]
│   └── generate-venue-profiles.ts # provenance付き profile artifact の再生成 [担当C]
├── public/                      # 生成物(git 管理外)
├── tests/                       # vitest                                 [担当F]
└── .github/workflows/
    ├── update.yml               # 日次 cron: 収集→生成→コミット→Pages    [担当E]
    ├── discover.yml             # 週次 cron: 穴場会議・ジャーナル自律探索 [担当G]
    └── ci.yml                   # PR/push: vitest + 出力検証             [担当E]
```

**担当は自分のファイルだけを書く。他担当のファイルを作成・編集しない。**
**ビルドが他担当の所有ファイル（README.md 等）を書き換えることはしない。**

---

## 3. 凍結インタフェース（`src/model.ts`・担当A が実装、他は前提として使う）

```ts
// 型・時刻解決・日付パーサ・snapshot 入出力（src/model.ts）
export interface Deadline { kind: string; label: string; at_utc: Date; tz_raw: string; round: number; comment: string | null; }
export interface DeadlineEstimate { point_estimate: string; window_start: string; window_end: string; source_editions: number[]; method: "median-interval"; confidence: "low" | "medium"; }
export interface Edition { year: number; edition_id: string; link: string; place: string; date_text: string; event_start: Date | null; event_end: Date | null; deadlines: Deadline[]; estimated: boolean; estimate?: DeadlineEstimate; source: string; }
export interface Conference { key: string; title: string; full_name: string; link: string; rank: Record<string, string>; dblp: string | null; upstream_sub: string | null; tags: string[]; categories: string[]; editions: Edition[]; sources: string[]; }
```

AOE = timezone(timedelta(hours=-12))          # Anywhere on Earth

# 締切種別は 10 種。上流の意味を潰さないことを優先する
DeadlineKind = str   # 'abstract'|'paper'|'supplementary'|'notification'|'camera_ready'
                     # |'rebuttal_start'|'rebuttal_end'|'review_release'|'registration'|'other'

@dataclass(frozen=True)
class Deadline:
    kind: DeadlineKind
    label: str                 # 表示用（例 'Paper submission'）。上流の label を優先
    at_utc: datetime           # tz-aware, UTC。必ず aware
    tz_raw: str                # 元の文字列（'AoE' 等）
    round: int = 1             # 1 起点。複数投稿ラウンド
    comment: str | None = None

@dataclass
class Edition:
    year: int
    edition_id: str            # 'sigcomm26'。表示用。上流で一意ではない
    link: str
    place: str                 # 'Denver, Colorado, USA'
    date_text: str             # 'August 17 - 21, 2026'（自由文のまま保持）
    event_start: date | None
    event_end: date | None
    deadlines: list[Deadline] = field(default_factory=list)
    estimated: bool = False    # 推定で生成した版
    source: str = ''           # 'ccfddl' | 'aideadlines' | 'local'

@dataclass
class Conference:
    key: str                   # 正規化キー。§3.1 の規則で決まる。例 'sigcomm'
    title: str                 # 'SIGCOMM'
    full_name: str
    link: str
    rank: dict[str, str] = field(default_factory=dict)   # {'ccf':'A','core':'A*'}
    dblp: str | None = None
    upstream_sub: str | None = None    # ccfddl の sub。分類とキー曖昧性解消に使う
    tags: list[str] = field(default_factory=list)
    categories: list[str] = field(default_factory=list)  # merge 段階で確定
    editions: list[Edition] = field(default_factory=list)
    sources: list[str] = field(default_factory=list)
```

### 3.1 キーの決め方（衝突が実在するので規則を凍結する）

```ts
// src/model.ts
export function slug(title: string): string;
// 小文字化、英数字以外を '-'、連続 '-' を畳む、前後 '-' 除去
// 'Hot Interconnects' -> 'hot-interconnects', 'IH&MMSec' -> 'ih-mmsec'
```

各 Source の Conference は `key = slug(title)` を持つ（ccfddl・aideadlines・local 共通）。
**同一 key に別会議が載ったときは merge_sources が upstream_sub で分割する**
（§3.6）。`key_overrides` のような設定は持たない。

実データで確認された衝突は 2 組。`data/overrides.yaml` の `aliases` と
`merge_sources` の分割で解決する。

| 上流 | title | 実体 | 解決後 key |
|---|---|---|---|
| `SC/fse.yml` | FSE | Fast Software Encryption | `fse`（sub が辞書順先） |
| `SE/fse.yml` | FSE | Foundations of Software Engineering | `fse-se` |
| `DS/sec.yml` | SEC | ACM/IEEE Symposium on Edge Computing | `sec` |
| `SC/sec.yml` | SEC | IFIP Information Security Conference | `sec-ifip` |

**新たな衝突が上流に生じたら CI を落とす。** `tests/merge.test.ts` で
「同じ key を共有する会議が 0 件（sub 分割後）」を検査する。
自動で `-{sub}` を付けて回避してはならない（既存 key が動いて識別子が変わり、
公開データの識別子が変わる）。

ccfddl と hf で同一会議が別 title になっている組は `data/overrides.yaml` の
`aliases` で寄せる。実データで確認済みの 3 組を初期値とする:
`kdd`→`sigkdd`、`siggraph`→`acm-siggraph`、`cec`→`ieee-cec`。

### 3.2 時刻と日付

```ts
// src/model.ts
export type Tz =
  | { kind: "fixed"; offsetMinutes: number }
  | { kind: "iana"; name: string };

export function resolveTz(tzRaw: string | null | undefined): Tz;
// 'AoE'/'aoe' -> {kind:'fixed', offsetMinutes:-720}
// 'UTC' / 'GMT' / '' / null / undefined -> {kind:'fixed', offsetMinutes:0}
// 'UTC+8' 'UTC-08' 'GMT+02' 'UTC+0' 'UTC+05:30' -> 固定オフセット
//   （ゼロ埋め・1〜2桁・コロン区切りの全てを受ける）
// 'PT' 'PST' 'PDT' -> {kind:'iana', name:'America/Los_Angeles'} ※固定オフセット禁止
// 'EST'/'EDT'/'ET' -> 'America/New_York', 'CET'/'CEST' -> 'Europe/Paris'
// IANA 名（'/' を含む）-> {kind:'iana', name: <そのまま>}
// 不明 -> UTC を返し、警告を 1 回だけ記録

export function parseInstant(text: unknown, tzRaw: string | null | undefined): Date | null;
// 'YYYY-MM-DD HH:MM:SS' / 'YYYY-MM-DD HH:MM' / 'YYYY-MM-DD' を受ける
// naive として読み、resolveTz の tz を付与し、UTC に変換して返す
// 'TBD' 等パース不能は null（例外にしない）
// 日付のみの場合は 23:59:59 とみなす

export function parseDateRange(
  text: string | null | undefined,
  fallbackYear: number,
): [Date | null, Date | null];
// 'August 17 - 21, 2026'            -> (2026-08-17, 2026-08-21)
// 'September 29 - October 3, 2025'  -> (2025-09-29, 2025-10-03)
// 'June 28 - July 2, 2026'          -> (2026-06-28, 2026-07-02)
// 'Oct 12-16, 2025' / 'Sept. 12-16, 2025' -> 略記・ピリオド・'Sept' を受ける
// 'November 15, 2026'               -> (2026-11-15, 2026-11-15)
// 'July 31-August 8, 2022'          -> (2022-07-31, 2022-08-08)
// en dash '–' も区切りとして受ける
// 年跨ぎ 'December 28, 2025 - January 3, 2026' は各側の明示年を優先
// date 中の明示年が Edition.year と食い違う場合も date を優先する（罠 §1.1-9）
// 解釈不能 -> [null, null]。例外にしない
```

rankings のパースは `src/sources/aideadlines.ts` の内部関数 `rankOf`:
`'CCF: A, CORE: A*, THCPL: A'` -> `{ccf:'A', core:'A*', thcpl:'A'}`、
`null` / 解釈不能 -> `{}`。

### 3.3 締切種別の正規化

```ts
// src/model.ts
export function kindOf(rawTypeOrKey: string | null | undefined): DeadlineKind;
```

`raw` の入力は **ccfddl の timeline キー名**と **hf の `type` 値**の両方である。
実在値からの写像を全て書き下す。ここに漏れがあると締切が消える。

| raw | kind |
|---|---|
| `deadline`, `paper`, `submission`, `full_paper` | `paper` |
| `abstract_deadline`, `abstract deadline`, `abstract` | `abstract` |
| `supplementary` | `supplementary` |
| `notification`, `first-notification`, `final-notification` | `notification` |
| `camera_ready`, `camera-ready`, `revision-deadline` | `camera_ready` |
| `rebuttal_start` | `rebuttal_start` |
| `rebuttal_end`, `rebuttal`, `rebuttal_and_revision`, `author_response` | `rebuttal_end` |
| `review_release` | `review_release` |
| `registration`, `reviewer_registration`, `commitment_deadline` | `registration` |
| 上記以外（`withdrawal` 等） | `other` |

`supplementary` を `paper` に落としてはならない（CVPR は本文と補足で別日）。
`rebuttal_start` と `rebuttal_end` を同一 kind にしてはならない（AAAI は開始と終了が別日）。

### 3.4 取得源

```ts
// src/sources/base.ts
export interface Source {
  name: string;
  load(cacheDir: string, opts: { offline?: boolean }): Promise<Conference[]>;
}

export async function fetchTarball(
  repo: string,
  ref: string,
  cacheDir: string,
  opts: { offline?: boolean },
): Promise<string>;
// codeload から tar.gz を取得して cacheDir 配下へ展開、展開先ルートを返す
// 展開時に path traversal を防ぐ（'..' や絶対パスを含むメンバを拒否）
// offline=true かつキャッシュがあればそれを使う。無ければ throw
// ネットワーク失敗時は既存キャッシュへフォールバックし警告
```

実装: `src/sources/ccfddl.ts`（`NAME = "ccfddl"`・`REPO = "ccfddl/ccf-deadlines"`）、
`src/sources/aideadlines.ts`（`NAME = "aideadlines"`・`REPO = "huggingface/ai-deadlines"`）、
`src/sources/local.ts`（`NAME = "local"`・`data/extra.yaml`）。

### 3.5 スナップショット（上流障害時の復旧経路）

`.cache/` は git 管理外であり、GitHub Actions の checkout には存在しない。
上流取得が失敗したときに頼れるのはコミット済みの `data/snapshot.json` だけである。

`cli.build`（`src/cli.ts` の `cmdBuild`）の取得順序を凍結する:

1. 各 Source を順に `load()` する。
2. **全 Source が失敗した場合に限り** `data/snapshot.json` から
   `restoreSnapshot()` で復元し、警告を出して処理を継続する（サイトを壊さない）。
3. 一部の Source だけ失敗した場合は、成功した分に snapshot の該当分をマージして継続する。
4. snapshot も空なら異常終了する（黙って空の公開データを公開しない）。

snapshot の書き込みは build の最後に `data.json` を `data/snapshot.json` へ
コピーする（`generated_at` を含まない・§4.1 と同一スキーマ）。

**退避時の local 再適用**: snapshot は「最後に健全な online ビルドが生成した
時点」のデータなので、その後に `data/extra.yaml`（local source）へ追加された
会議・締切（新規収録・通知締切など）を含まない。local source はローカル
ファイルなので上流障害時も読めるため、`restoreSnapshot()` の復元データに
`mergeSources()` で local を再マージしてから overrides を再適用する
（`local` は `source_priority` 最上位なので、snapshot 側の古い締切を正しく
上書きする）。local グループが空なら再マージを省略する（従来動作と同一）。

**注意**: `--out` がどこでも、`--offline` でなく健全な build なら snapshot を
上書きする（`--now` 指定の検証 build も例外ではない）。検証で `--now` を
使ったあとは `git checkout -- data/snapshot.json` で戻すこと。

### 3.6 統合

```ts
// src/merge.ts
export const DEFAULT_SOURCE_PRIORITY = ["local", "aideadlines", "ccfddl"];
export const DEFAULT_CROSS_SOURCE_TOLERANCE_S = 90000; // 25 h

export function mergeSources(
  groups: Conference[][],
  config: Record<string, unknown>,
  stats?: MergeStats | null,
): Conference[];
// key で名寄せ（aliases 適用後）。同一 key の Conference をマージ
// 同一 key で upstream_sub が異なる会議は分割する（§3.1 の FSE/SEC）
//   sub が辞書順先の bucket が素の key、後続は `<key>-<sub-lowercased>`
// Edition は year で突き合わせる
// Deadline は和集合を取ったあと、下記「締切の重複統合」の許容幅で畳む
// 競合時の優先順は config['source_priority']（既定 ["local","aideadlines","ccfddl"]）
// stats は任意の出力引数。merged_deadlines と merged_by_key を受け取る

export function classify(confs: Conference[], config: Record<string, unknown>): Conference[];
export function applyOverrides(
  confs: Conference[],
  overrides: Record<string, unknown> | null | undefined,
): Conference[];
// editions.<year>.deadlines が指定されたらその版の締切を**置換**する
// （延長・訂正用。drop と違い、rollforward が推定版を再生成しない）。
// 形式は extra.yaml と同じ kind/label/date/tz。根拠 URL をコメントで残す。
export function rollforward(
  confs: Conference[],
  today: Date,
  config: Record<string, unknown>,
): Conference[];
// 最新版の paper 締切が過去で、未来の版が無い会議に推定版を 1 つ足す
// 推定間隔は直近 2 版の実間隔の中央値、取れなければ 364 日。曜日を保つ
// 未来の版が既に存在する会議には足さない
export function select(confs: Conference[], config: Record<string, unknown>): Conference[];
// カテゴリ・exclude・rank_filter に加え、締切も開催日も持たない会議を落とす
// （全出力が日付を軸にするので、そういう会議はどこにも描画されず件数だけ増やす）
export function dedupDeadlinesAfterRollforward(
  confs: Conference[],
  config: Record<string, unknown>,
): Conference[];
```

#### 締切の重複統合

対象は同一 Conference・同一 Edition・同一 `kind` の 2 件で、**畳む条件は源が同じか
異なるかで別**である。`round` は突き合わせに使わない。

| 2 件の出どころ | 畳む条件 |
|---|---|
| **異なる源** | `at_utc` の差が許容幅以内。既定 **90000 秒（25 時間）**。`config['deadline_merge_cross_source_seconds']` で変えられる |
| **同じ源** | `at_utc` が完全一致し、かつ空白と大小文字を正規化した `label` も一致 |

窓の中に候補が複数あるときは**最も近いもの**に畳む。先頭一致にすると、SIGGRAPH 2026 で
ccfddl の `Paper submission`（`2026-01-22T22:00:00Z`）が aideadlines の
`Upload and conflicts deadline`（24 時間後）に吸われうる。

**なぜ源で規則を分けるか（実データ全件走査で確認済み・2026-08-09 時点）**

源をまたぐ食い違いは秒の丸めから暦日そのもののずれまで連続的に分布する。

| 差 | 実例 |
|---|---|
| 1 秒 | NeurIPS の paper が ccfddl `11:59:00Z`・aideadlines `11:59:59Z` |
| 1 時間 + 59 秒 | SGP 2026 の abstract / paper（時差解釈 1 時間と秒丸めの合成で 3659 秒） |
| 4〜12 時間 | FG・IROS・ICASSP・COLT・ICDAR・Interspeech。源ごとに元の壁時計を別のタイムゾーンで読んでいる |
| 24 時間 | CVPR 2026 の abstract（`11-07 11:59:00Z` と `11-08 11:59:59Z`）、IROS 2025・WACV 2027 の paper |

3600 秒では源をまたぐ重複が **21 組**残り（実測）、`rollforward` がそのうち
**9 件**を推定版へ複製して増幅していた。
一方で**同じ源が同一時刻に並べた 2 件は本当に別トラックのことがある**
（SIGGRAPH 2026 は `2026-04-21T22:00:00Z` に投稿トラックを 3 本持ち、
WACV は Round 1 と Round 2 の通知を同一時刻に置く）。源を問わず窓で畳むと
これらが消えるため、同一源には完全一致を要求する。

25 時間という値は「タイムゾーン解釈差の上限」ではなく実測に対する閾値である。
源をまたぐ同一 kind の差の分布には 24.02 時間の次が 26 時間で、
そこから先（ALT 26h・ICRA 27h・ECCV 130h ほか）は投稿締切の延長や
別トラックが混ざるので畳まない。**この境界はテストで固定する。**

**畳むときの規則**

- 残すのは `source_priority` が高い側の値・ラベル・`comment`・リンク。同順位のときは
  和集合に先に入った側（＝上流の記載順）が残る。
- `round` は**大きい方**を採る。ただし源をまたぐときに限る。aideadlines には
  round の概念が無く常に 1 を返すので、優先源に決めさせると ccfddl の round 2 が
  round 1 に潰れる（実測 11 件。WACV 2027 が「概要締切 R2 / 論文締切 R1」という
  自己矛盾した表示になっていた）。同一源どうしの `round` は比較可能なので勝者のものを残す
  （GECCO の同時刻 2 トラックは round 1 のままにする）。
- 落とした側の `label` と `comment` は、残した側の `comment` に
  `同時刻の別記載: <label>` として退避する。**文字列を捨ててはならない。**
- `kind` が違えば畳まない（CVPR の paper と supplementary は同時刻でも別物）。
- 窓を超えて離れた同一 `kind` は畳まない。NSDI の年 2 ラウンドは数か月離れており
  影響を受けない。**この不変条件はテストで固定する。**

**畳んだ後に残る同時刻の重複**

同一源の別トラックは残るので、同一 Edition・同一 `kind`・同一 `at_utc` に 2 件以上
並ぶことがある。このとき `upcoming.md` の種別欄とサイトの種別欄には
`論文締切: Posters deadline` のように `label` を添えて**区別できるようにする**。
区別できない同一表題の重複を出力に残してはならない。

**適用箇所**

この畳み込みは `merge_sources` の中で全源が寄与した後に 1 回、
`rollforward` の**後にもう 1 回**適用する（`dedup_deadlines`）。推定版は直前の実版の
締切を写すので、残った重複はそのまま推定版へ複製される。統合済みの Edition は
どの締切がどの源から来たかを保持していないため、後段の 1 回は同一源の規則
（時刻とラベルの完全一致）だけを適用する。

統合件数は `build` の統計に出す。件数は **収録された会議のぶんだけ**数える
（`merge` は `select` より前に走るため、収録しない会議まで数えると `data.json` と
突き合わせられない）。

### 3.7 出力と CLI

```ts
// src/build.ts
export async function buildAll(
  confs: Conference[],
  config: Record<string, unknown>,
  outdir: string,
  now: Date,
): Promise<BuildStats>;
```

```sh
node --experimental-strip-types src/cli.ts build [--out public] [--config config.yaml]
                              [--offline] [--now 2026-08-09T00:00:00Z] [--cache .cache]
                              [--no-embeddings]
node --experimental-strip-types src/cli.ts discover [--out path] [--categories hpc,systems]
                              [--candidate-out path] [--min-year 2026] [--dry-run] [--append]
node --experimental-strip-types src/cli.ts review [--candidates data/discovered_candidates.yaml]
                              [--limit 60] [--now 2026-08-09T00:00:00Z]
```

`--offline` は「新規取得をせず、キャッシュ → snapshot の順で退避する」。
`--now` は決定的テストのため必須で実装する。既定は実時刻 UTC。
時刻成分がある値は `Z` または `±HH:MM` offset を必須とする。offset 無し
（`2026-08-09T00:00:00`）はローカル時刻になり決定性を壊すので拒否する。
`T24:00:00Z` も Date が翌日へ繰り上げるので拒否する。日付だけ
（`2026-08-09`）は UTC 0 時とする。
`--no-embeddings` は `embeddings.json` を書かない（テスト用・高速化）。
`discover` は穴場の会議・ジャーナルを探索し、`review` は候補を締切昇順・重複・
predatory 疑い付きで一覧する。
（rev.1 にあった `--no-fetch` は `--offline` と区別がつかないので削除した。）

---

## 4. 生成物（`public/` 配下）

標準ビルドは次のファイルを生成する。推定値は `data.json` と `data.csv` に含め、
`estimated` フラグで確定値と区別する。

| ファイル | 内容 |
|---|---|
| `index.html` | 静的サイト（テンプレートに正規化データを埋め込む） |
| `data.json` | 正規化データ全体（機械可読の正）。推定版も含む |
| `health.json` | 確定・推定締切、ソース状態、警告、カテゴリ、出力ファイルの健全性レポート |
| `health.md` | `health.json` の人間向け要約 |
| `catalog.json` | 締切画面向けの現在・近日期間カタログ。履歴と論文プロフィールを含めず、全履歴の `history_ref` を持つ |
| `recommendation-index.json` | 投稿先推薦用の会議プロフィール、代表締切、埋め込みマニフェスト参照 |
| `data.csv` | 1 行 1 締切の平坦な表。推定版も含む |
| `upcoming.md` | 直近 N 日の締切と開催日の表（N は `site.upcoming_days`、既定 180） |
| `llms.txt` | エージェント向け出力索引 |
| `embeddings.json` | 会議スコープの埋め込み（§10）。`--no-embeddings` で省略可 |
| `recommender.js` | サイトの推薦ロジック |
| `app.js` | ブラウザUI runtime（TypeScript の `allowJs` 対象） |
| `.nojekyll` | Pages の Jekyll 処理を無効化 |

`health.json` は `profile_hash`、`confirmed_future_deadlines`、`estimated_future_deadlines`、
`source_failures`、`snapshot_fallback`、`parse_warning_count`、カテゴリ別件数、
必須会議の存在状態を持つ。last-known-good との比較では確定値の崩落だけを配信阻止対象とし、
推定値の増減だけでは阻止しない。

`index.html` に埋め込む JSON は `catalog.json` と同一である。推薦モードは
`recommendation-index.json` を遅延取得し、`embeddings.json` を参照する。
`data.json` は全履歴を含む機械可読の正典として、サイトシェルには埋め込まない。
サイトの通常起動では `data.json` を取得せず、締切モードで過去の締切を表示するときだけ
`history_ref` を同一 origin から一度だけ遅延取得する。取得中は状態を表示し、非 2xx・不正 JSON・
不正な `conferences` 配列の場合は埋め込み済みカタログを使い続けて再試行を可能にする。
推薦モードは URL に `past=1` があっても履歴を取得しない。推定の表示切替はサイト側の絞り込みで行う。
`upcoming.md` には締切と開催日の両方を載せる。締切を持たない会議も開催行で確認できる。

**`upcoming.md` の行の選び方**: 締切行は `at_utc` が `now` から N 日以内のもの。
開催行は開始日が N 日以内で、最終日をまだ過ぎていないものを載せる。
開催行の「残り」欄は開始前が日数、開始日が `本日開催`、会期中が `開催中(残りN日)`。

### 4.1 `data.json` の形

```json
{
  "generated_at": "2026-08-09T00:00:00Z",
  "site": {"domain": "ten82e.github.io", "base_url": "https://ten82e.github.io/kamiyobi"},
  "sources": [{"name": "ccfddl", "repo": "...", "license": "MIT", "url": "..."}],
  "categories": {"hpc": "High Performance Computing", "...": "..."},
  "conferences": [
    {"key":"sigcomm","title":"SIGCOMM","full_name":"...","categories":["networking"],
     "rank":{"ccf":"A","core":"A*"},"link":"...","sources":["ccfddl"],"tags":[],
     "papers":["..."],
     "editions":[{"year":2026,"id":"sigcomm26","place":"...","link":"...",
       "event_start":"2026-08-17","event_end":"2026-08-21","estimated":false,
       "deadlines":[{"kind":"paper","label":"...","utc":"2026-02-06T23:59:59Z",
                     "aoe":"2026-02-06 23:59:59 AoE","tz_raw":"AoE","round":1,
                     "status":"confirmed",
                     "selection_rule":"source_priority_then_nearest_within_configured_window",
                     "evidence":[{"source_name":"ccfddl",
                       "source_url":"https://github.com/ccfddl/ccf-deadlines",
                       "observed_at":"2026-08-09T00:00:00Z",
                       "original_value":"2026-02-06 23:59:59 AoE",
                       "confidence":"aggregator"}],
                     "conflicts":[{"at_utc":"2026-02-06T23:59:00Z",
                       "label":"Paper submission","source":"aideadlines",
                       "original_value":"2026-02-06T23:59:00Z",
                       "evidence":[{"source_name":"aideadlines",
                         "source_url":"https://github.com/huggingface/ai-deadlines",
                         "observed_at":"2026-08-09T00:00:00Z",
                         "original_value":"2026-02-06T23:59:00Z",
                         "confidence":"aggregator"}]}]}]}]}
  ]
}
```

---

## 5. 分類とキュレーション（`config.yaml`・担当B）

カテゴリは `hpc` / `networking` / `systems` / `ai` / `security` の 5 つ。
方針は **上流サブ分野の丸ごと取り込み + 例外リスト**（新規会議が自動で現れることが要件）。

rev.1 の設定を実データに当てたところ、351 会議中カテゴリが付くのは 196、
rank_filter 通過は 149 で、**HotNets・APNet・SIGMETRICS・MLSys・USENIX ATC・Euro-Par が
落ちていた**。以下はその実測を踏まえた修正版である。

```yaml
key_overrides:            # §3.1。固定値。勝手に変えない
  SC/fse: fse-crypto
  SE/fse: fse-se
  DS/sec: sec-edge
  SC/sec: sec-ifip

taxonomy:
  networking: {ccfddl_subs: [NW]}
  ai:         {ccfddl_subs: [AI], include_sources: [aideadlines]}   # OR 合成
  security:   {ccfddl_subs: [SC]}
  hpc:        {venue_slugs: [sc, ipdps, hpdc, icpp, cluster, ppopp, ics, euro-par,
                             ccgrid, pact, hpcc, ica3pp, ispa, pdcat, appt, mlsys, ...]}
  systems:    {ccfddl_subs: [SE], venue_slugs: [asplos, isca, micro, hpca, fast,
                             sigops-atc, eurosys, socc, sigmetrics, icdcs, podc, rtas,
                             msst, vee, apsys, hot-chips, hotstorage, lisa, ...]}

# taxonomy 内の条件は OR 合成。exclude が最優先で打ち消す
exclude: [popl, pldi, icfp, oopsla, ecoop, aplas, cp, sas, vmcai, ...]

category_overrides:       # 上流の分野割り当てが実態と合わない会議
  pam: [networking]       # ccfddl は sub=SC。実体は Passive and Active Measurement

rank_filter:
  ccf: [A, B]
  core: ['A*', A, B]
  thcpl: [A, B]           # HotNets は ccf C / core N / thcpl B。thcpl 無しだと落ちる
  # 3 つの OR。'N' とキー欠落は「該当ランク無し」であり通過条件に数えない
  venue_allowlist: [hotnets, apnet, apsys, hot-chips, hotstorage, sec-edge]
                          # ランクに関わらず必ず残す
  keep_sources: [local]   # rev.1 の keep_if_no_rank は hf 全 68 会議を素通りさせるので廃止
```

**綴りの罠（実データと照合済み）**: `atc` は存在せず `sigops-atc`（USENIX ATC 相当、ccf A）、
`europar` は存在せず `euro-par`。`hoti` と `ancs` は ccfddl に存在しない。

**MX 分野の扱い**: `MX/mlsys.yml` に **MLSys が実在する**。`MX/rtss.yml` `MX/emsoft.yml`
（実時間システム、TSN/DetNet に近い）も同様。MX 全体を取り込むと `www` `miccai` 等が
混ざるので、venue_slugs で名指しして拾う。`data/extra.yaml` に MLSys を重複登録しない。

**DS 分野の全数割り当て**: DS 60 会議のうち rev.1 では 44 会議が無カテゴリだった。
担当B は `conference/DS/` を一件ずつ見て hpc / systems / exclude のいずれかに割り当て、
未分類が 0 件であることを検査スクリプトで実測すること。

### `data/extra.yaml`（上流に無い会議）

収録対象: ISC High Performance / Hot Interconnects (HOTI) / OCP Global Summit /
Netdev / Linux Plumbers Conference / P4 Workshop / IEEE HPSR /
情報処理学会 HPC 研究会・ARC 研究会・OS 研究会・DPS 研究会 /
電子情報通信学会 NS 研究会・IN 研究会 / ComSys / IOTS / インターネットコンファレンス。

**MLSys は上流にあるので入れない。**
ANCS は 2021 年以降開催されていない。収録しない旨を §9 に記す。

**でっち上げた締切を入れない。** 日付の裏が取れないものは開催イベントとしてのみ出し、
`deadlines` を空にする。各エントリに根拠 URL をコメントで残す。
公式サイトで確認できなかったものは「未確認のため日付なし」と明記する。

`local` 由来は `key` を明示指定でき、`slug(title)` の規則より優先する。

```yaml
conferences:
  - key: isc-hpc                      # 明示指定。slug(title) より優先
    title: ISC High Performance
    full_name: ISC High Performance
    link: https://isc-hpc.com/
    categories: [hpc]
    editions:
      - year: 2026
        id: isc26
        link: https://isc-hpc.com/
        place: Hamburg, Germany
        date_text: June 14-18, 2026
        deadlines:
          - {kind: paper, label: Research Paper submission, date: '2025-10-27 23:59:59', tz: AoE}
```

### `data/primary.yaml`（一次ソースからの自動抽出）

手書きの `overrides.yaml` に頼らず、公式ページから締切を**一発どり**する仕組み。

- `data/primary.yaml` に会議ごとの一次ソース URL と edition 年を登録する
  （URL の発見だけが人間の仕事。データの訂正は以後自動）。
- `src/fetch-primary.ts` が各 URL を取得し、「deadline キーワード行の近傍
  （前後 1 行）の日付」だけを保守的に抽出して `data/primary_overrides.yaml`
  （自動生成・手編集禁止）を書く。
- build (`src/cli.ts` の `cmdBuild`) は `overrides.yaml` → `primary_overrides.yaml`
  の順に適用し、**一次ソースの実測を最優先**にする。
- 抽出した edition が上流に存在しない場合、`_patch_editions` が新規 edition として
  追加する（`source: override`・`estimated: false`）。rollforward はその実測を基準に
  次 edition を推定する。
- 安全ルール:
  - 「deadline」を含まない行の裸の日付は抽出しない（会議開催日等の誤検出防止）。
  - 抽出日付の年は「edition 年・前年」のみ。ページ `<title>` の年がレジストリの
    edition 年と一致する場合のみ title の年を採用する（過去版の残骸を拾わない）。
  - 取得失敗・抽出 0 件の会議は**前回値を維持**する（一時的なサイト障害で
    データが消えない）。警告は stderr に出るので、レジストリの URL が古くなると
    気づける。
- CI (`update.yml`) は build の前に `node --experimental-strip-types src/fetch-primary.ts --apply` を
  実行し、毎日自動で一次ソースを巡回する。
- 向き不向き: EasyChair CFP (`easychair.org/cfp/...`) と静的 HTML の CFP /
  Important Dates ページは抽出しやすい。JS レンダリングサイト（wacv.thecvf.com /
  vldb.org / bigdataieee.org 等）は静的 HTML に締切が無く現行抽出では 0 件になる
  ため登録しない。必要になったら個別の抽出ルールを `src/fetch-primary.ts` に足す。

---

## 6. GitHub Actions（担当E）

### `.github/workflows/update.yml`

- `on: {schedule: [{cron: '17 20 * * *'}], workflow_dispatch: }`（20:17 UTC = 05:17 JST）
- `permissions: {contents: write, pages: write, id-token: write}`
- build と推薦 bundle の検証後、`scripts/health-gate.ts` が公開済み `health.json` を
  last-known-good として比較し、確定締切の大幅減少、必須会議欠落、警告急増、
  profile 不一致、snapshot 無しのソース障害を検出した場合は Pages への配信を止める。
- `concurrency: {group: pages, cancel-in-progress: false}`（**update.yml にのみ付ける**。
  concurrency group はリポジトリ全体で共有されるため、ci.yml に付けると CI が
  デプロイと直列化して不利益になる）
- 手順: checkout → setup-node 24 → `npm ci` →
  `node --experimental-strip-types src/fetch-primary.ts --apply`（一次ソース自動抽出）→
  `node --experimental-strip-types src/cli.ts build --out public` →
  `data/snapshot.json` / `data/primary_overrides.yaml` のどちらかに実質差分が
 あれば両方コミット（`scripts/compare-head.ts` が `generated_at` / `_comment` の
 日付変化を無視して判定）→ `actions/upload-pages-artifact@v5` →
 `actions/deploy-pages@v5`
- 上流取得に失敗しても §3.5 の退避経路でサイトを壊さない。
- GITHUB_TOKEN による push は workflow を再起動しない（公式明記）ため、
  無限ループは起きない。`[skip ci]` は不要だが付けても害は無い。
- update.yml に `pull_request` / `pull_request_target` トリガを**追加しない**
  （`contents: write` と組み合わせると公開リポジトリで危険になる）。

**cron の 60 日無効化について（未検証と明記する）**
GitHub は公開リポジトリで「60 日間リポジトリ活動が無いと scheduled workflow を自動停止する」
と公式に述べている。しかし **「活動」の定義も、GITHUB_TOKEN による bot コミットが
それに数えられるかも公式ドキュメントに記載が無い**。
既知の keepalive 実装のうち、PhrozenByte は GITHUB_TOKEN では権限不足として PAT を要求し、
gautamkrishnar/keepalive-workflow は GitHub Staff により利用規約違反として無効化されている。

したがって:

- 活動を偽装する目的のハートビートコミットは実装しない。
- `data/snapshot.json` は上流が変わるたびに更新されるので、副次効果として活動が発生する。
  これを唯一の対策とし、**効果は未検証であると README に明記する。**
- `workflow_dispatch` を残し、停止した場合の手動再有効化手順を README に書く。

### `.github/workflows/ci.yml`

配列形式の `on` はフィルタを受け取れない。次の形で書く。

```yaml
on:
  push:
    paths-ignore: [data/snapshot.json]
  pull_request:
    paths-ignore: [data/snapshot.json]
```

- job `test`（ネットワーク非依存）:
  `npm ci` → `npm run typecheck` → `npm run check` → `npm test`。
  テスト側に `tests/fixtures/` だけを源とする端から端までのビルド検証を含める。
- job `smoke`（`continue-on-error: true`・ネットワーク依存）:
  実際の上流を取りにいく `node --experimental-strip-types src/cli.ts build --out /tmp/site --now 2026-08-09T00:00:00Z`。
- `paths-ignore` でスキップされたジョブは required check として Pending のまま残るため、
  ブランチ保護を掛ける場合は required check に指定しない旨を README に注記する。

---

## 7. 静的サイト（`site/template.html`・担当D）

- **コア UI は静的テンプレートと checked runtime に分離**。表・絞り込み・テーマ・フォントは外部 CDN・
  Web フォント・外部画像を使わない（#223）。sibling の `recommender.js`（§10）は
  ビルドが `index.html` と同じディレクトリへ同梱する。UI runtime は `app.js` として
  同梱し、TypeScript のプログラムへ `allowJs` で含める。
- 推薦機能だけ、オフライン時フォールバック付きの任意 CDN を遅延ロードしてよい。
  許可するのは次の 3 URL に限る。
  `https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/+esm`、
  `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js`、
  `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js`。
  CDN が使えないときは語彙スコアと TXT 入力だけで動く。
- `index.html` は `Content-Security-Policy` を持ち、script / worker / model 接続を上記の
  固定 origin に限定する。`unsafe-inline` は単一テンプレート内の既存 inline script/style
  を維持するためだけに使い、外部 origin の wildcard は許可しない。
- ビルド時に、テンプレート中の文字列 **`/*__DATA__*/null`** が
  `data.json` 相当の JSON リテラルに置換される。これが唯一のマーカーである
  （rev.1 にあった `<!--DATA-->` は削除した）。
  担当C は JSON を JS ソースへ埋めるので `<` を `<` に、
  U+2028 / U+2029 をエスケープすること（実データに `&` を含む文字列が 17 箇所ある）。
  テンプレートが無ければ警告して index.html をスキップする（テストのため）。
- 表示: 締切までの残り時間（ブラウザのローカル時刻）と AoE 表記を併記。
- 絞り込み: カテゴリ / 締切種別 / ランク / フリーテキスト / 推定の表示切替 / 期間(7・30・90・180・全)。
  「締切直近 (7日以内)」プリセットは 7 日窓（`win=7d`）で動作する。
  絞り込み状態は URL のクエリに反映する（`replaceState` で履歴を汚さない）。
- **サイト表は投稿締切のみ表示する。** 2026-08-10 の意図的な狭小化
  （commit `c85fe0a`「投稿締切以外の機能を完全除去」）により、サイトの表は
  投稿締切（`abstract`・`paper`。論文モードのみ常時受付ジャーナル `journal`）だけを描き、
  開催・採否通知・カメラレディ等の行は出さない（種別の絞り込みにも含めない）。
  開催日だけを持つ会議（ISC High Performance・HOTI・情報処理学会 HPC 研究会・
  P4 Workshop・Netdev・LPC など）がサイト表から消えるのは仕様であり、利用者は
  `upcoming.md`（§4）で開催日を追う。
  開催行の過去判定（終了日 + 1 日）と残り日数の表示規則は §4 に定める。
  推定版には開催日を持たせないので、開催行が推定になることはない。
- 過去の締切は既定で非表示、トグルで表示。トグルを締切モードで有効にしたときだけ
  `catalog.json.history_ref` の全履歴を遅延取得し、既定の並びは締切が近い順。
- ライト/ダーク両対応（`prefers-color-scheme`）。表は `overflow-x: auto` の中でだけ
  横スクロールし、body は横スクロールさせない。狭い画面ではカード表示に落とす。
- 日本語 UI。ラテン文字の英単語を不必要に混ぜない
  （「フィルタ」ではなく「絞り込み」、「デッドライン」ではなく「締切」）。
- 1000 件規模でも操作が引っかからないこと。コア UI に依存ライブラリは置かない
  （推薦の任意 CDN は上の例外）。

---

## 8. テスト（`tests/`・担当F）

実装を読まずに本仕様だけから書く。

- `timezone.test.ts`: `resolveTz` の実在値 19 + 12 種すべて。`AoE` = UTC-12。
  `UTC-08` と `UTC-8` が同じ。IANA 名。**`PT` が夏と冬で異なるオフセットになること**。
  不明値が UTC にフォールバックすること。
- `parse.test.ts`: `parseInstant` の AoE→UTC 変換
  （`2026-04-08 23:59:00 AoE` → `2026-04-09T11:59:00Z`）。`TBD` が null。
  `parseDateRange` の月跨ぎ・年跨ぎ・略記月・`Sept.`・en dash・単日。
  上流 rankings の自由文字列変換（`rankOf`）。
- `kind.test.ts`: §3.3 の表の全 20 行。特に **`deadline` → `paper`**、
  `supplementary` が `paper` に潰れないこと、`rebuttal_start` と `rebuttal_end` が別物であること。
- `keys.test.ts`: sub 分割後も同じ key を共有する会議が 0 件であること
  （上流に新しい衝突が入ったら落ちる）。`aliases` が cross-source 名寄せを行うこと。
- `merge.test.ts`: 同一版に同じ kind の締切が複数あっても消えないこと
  （notification 3 本、submission 4 本のケース）。round の保持。overrides 適用。
  rollforward が未来版のある会議に推定を足さないこと。
  §3.6「締切の重複統合」の 3 事象（源間の丸め違い・上流内の同日ラウンド重複・
  源間の round 表現差）がそれぞれ 1 件に畳まれること。
  NSDI 型の数か月離れたラウンドと、許容幅の外側（3601 秒差）が畳まれないこと。
  締切も開催日も持たない会議が `select` で落ちること。
- `snapshot.test.ts`: build の最後に `data.json` → `snapshot.json` のコピーで
  情報が落ちないこと。全 Source が失敗したとき snapshot から復旧すること。
- `build_golden.test.ts`: 小さな固定入力から `--now` 固定でビルドし、
  ファイル一式が生成されること・JSON スキーマが §4.1 どおりであること。
  推定値が `estimated` フラグで確定値と区別されること。
  サイト表は投稿締切のみ（`index.html has no meeting rows`）。締切を持たない会議
  （ISC High Performance・HOTI・情報処理学会 HPC 研究会）の開催日は
  `upcoming.md` に出し、index.html の表には開催行を出さない。

`tests/fixtures/` に上流 YAML の**縮小版**を置く（ネットワーク不要）。
実物から次のエッジケースを含む代表を抜く:
nsdi（複数ラウンド）、sc（AoE）、sigcomm（abstract あり）、
ica3pp（**edition_id が全版で同一**）、fse（**別会議で id 重複**）、
neurips（hf 新形式）、cvpr（**新旧形式併存 + supplementary**）、
aaai（**rebuttal_start と rebuttal_end が別日**）、hf 旧形式 1 本、
`abstract deadline`（空白キー）1 本、date 自由文の月跨ぎ、`TBD` を含む 1 本。

---

## 9. 非目標

- WikiCFP など HTML スクレイピング（壊れやすく、利得が小さい）。
- 会議の採択率・査読統計。
- ユーザ登録・購読管理。
- 上流に無い会議の締切を推測で確定値として書くこと（推定は `estimated` フラグで区別する）。
- ANCS の収録（2021 年以降開催されていない）。
- README の締切テーブル自動更新（ビルドが他担当の所有ファイルを書き換える設計を避ける。
  README からは `public/upcoming.md` へリンクする）。
- 活動を偽装するハートビートコミット（§6 参照）。

---

## 10. 論文推薦システム（`site/recommender.js`・`src/embeddings.ts`）

論文タイトル/キーワード → 会議推薦のスコアリング。本番パスはブラウザ
（`site/template.html`）と恒久ベンチ（`npm run bench`）が同一コードを共有する。

### 10.1 スコア構成（実測で確定した最終形）

- 語彙スコア（`breakdown`）: 会議名・分野シグナル・VENUE_PAPERS 語彙との一致。
  適応ブレンド `vocabWeight`（EN: 内容語数 ≤4→0.25 / ≥5→0.4、JP: 0.6）。
- セマンティックスコア（`semanticScore`）: 埋め込み cosine。
  `public/embeddings.json`（`src/embeddings.ts` で生成、会議セット変化で自動再生成）。
- PRF（擬似関連性フィードバック）: 掲載先タグ付き論文はタグ会議の埋め込みを
  0.3 ブレンド。タグ付き top1 79%→97%（R8 実測）。
- 日本語: 多言語モデルを遅延ロード。語彙重み 0.6。normKey の FILLER 除去と
  語境界一致（単複形 s? 許容）を適用。

### 10.2 恒久ベンチ（`npm run bench`）

- 本番と同じコードパスで 446 会議の合成クエリ精度を計測（EN: top1 85.2% /
  top5 96.0% / top10 98.4%、2026-08-12 時点）。`--samples` / `--failures` /
  `--topk` / `--lang jp` / `--golden-en` オプション。
- `--golden-en`: 実採択論文タイトル（`GOLDEN_EN`、DBLP 由来・n=92）で真の精度を
  測る（top1 26.1% / top5 70.7% / top10 82.6%）。スコア改変の回帰検出に使用。

### 10.3 会議プロファイル拡充手順（`data/venue-profiles.json`）

失敗会議（golden で top5 外）の語彙を補う代表論文リストは、schema 2 の
provenance-bearing artifact から生成する。各論文は `title` / `year` / `source` /
`source_url` / `collected_at` を持ち、`selection` の `method` /
`max_prototypes` / `source_year_max` は全会議で共通でなければならない。
現在の共通方針は、出典リスト順を保つ `source-order-first`、上限 26、source year
上限 2025 である。`VENUE_PAPERS` はこの artifact から派生する互換ビューであり、
直接編集しない。

**拡充手順**:

1. 失敗会議の採択リストを一次出典または dblp から取得し、入力 JSON に出典 URL と
   収集時刻を付ける。
2. `node scripts/generate-venue-profiles.ts <input.json> data/venue-profiles.json`
   で正規化・検証・hash 付与する。空の provenance、重複タイトル、混在 cutoff、
   cutoff 超過、収集時点より未来の年は失敗させる。
3. `GOLDEN_EN`（テストセット）と重複しない論文だけを採用する
   （**同一タイトルを両方に入れるとリークになり、A/B が偽陽性になる** — R26 事故）。
4. `npx vitest run tests/recommender.test.ts -t "リークなし"` と
   `npm run bench -- --golden-en` で副作用を確認する。失敗例を見て個別に継ぎ足さず、
   同じ選定方針で artifact を再生成する。

適用済み: usenix-security / rtss / rtas / icdcs / ndss / osdi / sosp / icml /
eurosys / ppopp（R22-R24）。rtss・usenix-security は論文個別ベクトル
（paperVecs）も使用。paperVecs 適用条件は「1 分野に収まる + 語彙非衝突」の
2 条件（R21 で最終化: usenix-security・rtss のみ）。
