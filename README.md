# kamiyobi

高性能計算・ネットワーク・システム・人工知能・セキュリティ・データベース・グラフィックス・HCI・理論の国際会議および穴場ワークショップ・ジャーナルについて、論文投稿の締切と開催日を全自動で探知・配信する。
毎日 1 回自動で上流データを取得・自律探索し、JSON / CSV / Markdown と静的サイトを生成して GitHub Pages で公開する。
サーバも外部サービスも使わず、GitHub の中だけで完結している。

公開先は https://ten82e.github.io/kamiyobi/ である。

## 直近の締切と開催

直近 180 日の締切と開催の表は [upcoming.md](https://ten82e.github.io/kamiyobi/upcoming.md) にある。
締切を持たず開催日だけがわかっている会議も、開催の行としてここに出る。
この README は手書きで、ビルドが書き換えることはない。

## 生成物

投稿判断に使う正規化データ全体は `data.json`、一覧画面用の現在・近日期間カタログは
`catalog.json`、推薦モード用の会議プロフィールは `recommendation-index.json`、締切だけを扱う表は
`data.csv`、品質監視用の健全性レポートは `health.json`、直近の締切と開催日は `upcoming.md` にある。静的サイトでは会議名・締切・公式サイトを
検索でき、推薦機能は必要時に推薦インデックスを取得して論文の PDF/TXT をブラウザ内で処理する。
推薦インデックスは締切データと同じ公開物として維持され、埋め込みを取得・検証できない場合も
サイト全体は公開され、語彙スコアのみの推薦に切り替わる。

## 機械可読の出力

エージェントや自作の道具から使う場合は、次の 2 つを見るのが早い。

| ファイル | 用途 |
|---|---|
| `https://ten82e.github.io/kamiyobi/llms.txt` | 出力ファイルとデータの形を 1 枚にまとめた索引。まずここを読む |
| `https://ten82e.github.io/kamiyobi/data.json` | 正規化済みの全データ。会議・版・締切の三層構造。締切時刻は UTC と AoE 表記を併記 |
| `https://ten82e.github.io/kamiyobi/health.json` | 確定/推定締切、ソース失敗、警告数、カテゴリ件数、必須会議の健全性レポート |

他に、1 行 1 締切の平坦な表 [`data.csv`](https://ten82e.github.io/kamiyobi/data.csv) と、直近 180 日の締切と開催の表 `upcoming.md` がある。

## サイトの使い方（投稿先レコメンド）

公開サイト https://ten82e.github.io/kamiyobi/ の上部で、**読んだ論文（似た論文）または投稿予定の論文の PDF / TXT を選ぶだけ**で、合いそうな会議・ジャーナルを適合度順にランク付けする（複数ファイル可）。

- PDF は固定版 pdf.js で先頭 3 ページのタイトル・Abstract・Keywordsを読み取ってマッチングする（未接続環境では TXT のみ対応）。ページには許可済み CDN とモデル接続だけを記した CSP を設定している。
- 内部では 1 ファイルを `タイトル | 本文` の 1 行として処理する。掲載先タグ（`| RTSS` 等）による「掲載先一致」優先は手動の行入力時のみの機能だが、サイト上はアップロードが主経路のため通常は不要。
- 分野チップが空のときは論文内容から分野を自動判定して表示する（手動でチップを選ぶとその分野に絞る）。
- 英語・日本語どちらのタイトル/キーワードにも対応。日本語の場合は会議名の日本語表記と部分一致し、国内研究会（情報処理学会・電子情報通信学会等）も拾う。
- **AI セマンティック補助**: 会議スコープは build 時に all-MiniLM-L6-v2 で埋め込み済み（`embeddings.json`）。ブラウザで transformers.js が使える環境では、論文入力の埋め込みとコサイン類似度を計算し、語彙スコア（70%）と AI 類似度（30%）を合成する。CDN が使えない環境では語彙スコアのみで動作（フォールバック）。
- 埋め込みが未提供・不正・古い場合は、画面に AI 類似度が利用不可で語彙のみ有効であることを表示する。締切一覧はこの状態でも利用できる。
- AI 補助の runtime とモデル取得は固定 URL の外部接続を使う。接続できない場合も語彙検索と TXT 入力は継続する。
- 適合度は、分野シグナル・会議名・領域タグとの語彙一致と掲載先タグの合算。スコアリングの実装は `site/recommender.js` で、`tests/recommender.test.ts` が実データで回帰検証する。

## データ源とライセンス

| 名前 | リポジトリ | ライセンス |
|---|---|---|
| `ccfddl` | [ccfddl/ccf-deadlines](https://github.com/ccfddl/ccf-deadlines) | MIT |
| `aideadlines` | [huggingface/ai-deadlines](https://github.com/huggingface/ai-deadlines) | MIT |
| `local` | 本リポジトリの `data/extra.yaml` | MIT（本リポジトリ） |

発見ソース（候補生成）: `DBLP`・`OpenReview`・`wikiCFP`（70 カテゴリ）・`DBWorld` メーリス公開アーカイブ（[dbworld.sigmod.org](https://dbworld.sigmod.org/)）・`EasyChair` Smart CFP（[easychair.org/cfp](https://easychair.org/cfp/)）・購読メーリス `IMAP`（任意）・`IEEE ComSoc 誌特集号`（IEEE TNSM/TCCN/Network/Communications Magazine/Wireless Communications のオープン特集号 CFP）・`IEICE 論文誌特集号`（[journals.php](https://www.ieice.org/eng_r/information/schedule/journals.php) の特集号 CFP 一覧）・`IPSJ 論文誌特集号`（[論文誌ジャーナル募集一覧](https://www.ipsj.or.jp/journal/index.html) の特集論文募集）。DBWorld は購読不要の公開アーカイブで、wikiCFP に載らない併設ワークショップ・ジャーナル特集号・締切延長通知を拾う。EasyChair は運営者が登録した構造化 CFP（締切・場所・トピック）で、分野フィルタ適用済み。IMAP は GitHub Secrets（`CFP_IMAP_HOST`/`CFP_IMAP_USER`/`CFP_IMAP_PASS`）を設定すると受信トレイ直近 50 通から CFP メールを抽出する（未設定ならスキップ）。候補は締切を公式サイトで裏取りした後、`data/extra.yaml` に昇格する。

上流が扱わない会議は `data/extra.yaml` に自前で収録している。
帰属表示は [NOTICE.md](NOTICE.md) にある。
本リポジトリ自体のライセンスは MIT で、全文は [LICENSE](LICENSE) にある。

## 穴場の会議・ジャーナルの探索

上流に登録されていない特化ワークショップ、地域シンポジウム、ジャーナルの Call for Papers などの「穴場」を自律探索するには以下を実行する。

```sh
node src/cli.ts discover --dry-run
```

候補レジストリを永続化する場合:

```sh
node src/cli.ts discover --candidate-out data/discovered_candidates.yaml
```

`--out` は明示的に `extra.yaml` 互換の一時出力を作る場合だけ使う。
旧互換出力を追記する `--append` は、候補レジストリの更新には使わない。
`.github/workflows/update.yml` の `discover-candidates` ジョブが毎日これを実行し、
`data/discovered_candidates.yaml` に既存レコードをマージする。レビュー済みの状態・メモ・
初回発見時刻は維持され、再発見時は最終発見時刻と証拠だけが更新される。
候補は公式サイトで裏取りするまで `extra.yaml` には昇格しない。
探索対象を分野や年で絞るには `--categories`（例: `hpc,systems`）と
`--min-year`（省略時は実行時の UTC 年）を使う。

溜まった候補を締切昇順・重複・predatory 疑い付きで一覧するには `review` を使う。

```sh
node src/cli.ts review
```

`--limit` で表示件数を絞り、`--candidates` で候補 YAML の場所を変えられる。
候補の昇格（下記）の前に、ここで重複や怪しい候補を確認する。

**候補の昇格手順**（収録の裏取り原則: 締切は公式サイトで HTTP 確認できたもののみ）:

1. `data/discovered_candidates.yaml` から気になる候補を選ぶ
2. 候補の公式サイトで締切・開催日を確認する（wikiCFP 等の転載情報は裏取りに使わない）
3. 確認できたら `data/extra.yaml` に書き、`data/discovered_candidates.yaml` から該当行を消す
4. ビルドして収録されることを確認する

## 更新の仕組み

`.github/workflows/update.yml` が毎日 20:17 UTC（05:17 JST）に動く。
上流を丸ごと取得して正規化し、`public/` に出力を作り、GitHub Pages に配信する。
同時に `data/snapshot.json` を更新してコミットする。
このスナップショットは上流が落ちたときの退避先を兼ねており、取得に失敗した日は前回の内容から生成を続ける。
スナップショットでも補えないほど収集が縮退した日は、ビルドが非ゼロで終了して配信を行わない。
その日は前回配信した内容がそのまま残る（縮退した内容で上書きすると、公開データが消えるため）。

自動コミットは `github-actions[bot]` 名義で、メッセージに `[skip ci]` が付く。

公開リポジトリでは、60 日間リポジトリの活動が無いとスケジュール実行が自動で無効化される（[GitHub の公式文書](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)）。
対策は上のスナップショット更新の副次効果だけである。
bot のコミットが「活動」に数えられるかは公式文書に記載が無く、この対策が効くかは未検証である。
活動を偽装する目的のコミットは、利用規約違反として停止された前例があるため実装しない。
停止された場合は、リポジトリの Actions タブから `update` ワークフローを開き、`Run workflow`（`workflow_dispatch`）で手動実行すると再び有効になる。

`.github/workflows/ci.yml` は push と pull request で動く。
`test` ジョブは依存関係のインストール後、fetch guard、`tests/fixtures/`、snapshot を使う
上流ネットワーク非依存の必須検証で、
typecheck・lint・unit test と `--offline --no-embeddings` build を実行する。
`smoke` ジョブは実際の上流を現在時刻で取りに行き、埋め込み生成を省略して source/health 件数を表示するが、
上流障害で赤くならないよう必須にしていない。候補探索そのものは週次の `discover.yml` が担当する。
なお ci.yml は `paths-ignore` を使っており、`data/snapshot.json` だけを変えるコミットではジョブがスキップされる。
スキップされたジョブは必須チェック（required check）として Pending のまま残るため、ブランチ保護を掛ける場合はこれらを必須チェックに指定しない。

### 初回セットアップ

`update.yml` はカスタムワークフローから Pages に配信するため、リポジトリの設定が必要である（[GitHub の公式文書](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)）。
Settings の Pages を開き、Build and deployment の Source を「GitHub Actions」にする。
既定のままだと Deploy の段階で毎日失敗する。

## 手元で動かす

```sh
npm ci
node src/cli.ts build --out public
```

`public/index.html` をブラウザで開けばサイトを確認できる。

テストを走らせる。

```sh
npm test
```

その他の指定。

| 指定 | 意味 |
|---|---|
| `--config config.yaml` | 設定ファイルの位置 |
| `--out public` | 出力先 |
| `--now 2026-08-09T00:00:00Z` | 基準時刻を固定する。同じ入力で出力が一致することを確かめたいときに使う |
| `--cache .cache` | 上流の取得結果を置く場所 |
| `--offline` | 上流を取りに行かず、キャッシュ、それも無ければ `data/snapshot.json` を使う |
| `--no-embeddings` | 埋め込み（`embeddings.json`）を生成しない。モデル取得を避けてビルドを速くする（テスト・オフライン確認用） |

## 収録範囲を変える

`config.yaml` を編集する。

分野の割り当ては `taxonomy` にある。
上流の分野を丸ごと取り込む `ccfddl_subs` と、会議名を並べる `venues` の組み合わせで決めている。
個別許可リストにすると上流に新しく追加された会議が永久に出てこないため、この方式を採っている。
`venues` に書いた会議はランク判定を迂回して必ず残る（名指しは収録の意思表示でもある）。
特定の会議を外したいときは、その分野の `exclude` に会議のキーを足す。

```yaml
taxonomy:
  networking: {ccfddl_subs: [NW]}
  hpc:        {venues: [sc, ipdps, hpdc, icpp, cluster]}
```

ランクによる絞り込みは `rank_filter` にある。
空にすれば無条件で通る。
`keep_if_no_rank` を真にしておくと、ランク情報を持たない会議（`data/extra.yaml` 由来のものなど）が落ちない。

```yaml
rank_filter:
  ccf: [A, B]
  core: ['A*', A, B]
  keep_if_no_rank: true
```

上流に無い会議を足したいときは `data/extra.yaml` に書く。
上流の記述が誤っているときは `data/overrides.yaml` で訂正するか、除外する。
どちらも編集後は手元でビルドし直して結果を確かめる。

## 既知の限界

締切情報は上流データに依存しており、正確性を保証しない。
投稿の前に必ず各会議の公式サイトで確認すること。

推定締切は前年の同種の締切から機械的に作ったものである。`data.json` と `data.csv` に含めるが、
`estimated` フラグで確定値と区別している。サイト上でも推定であることを明示している。
根拠のない締切を確定値として扱わない方針を採っている。

締切を持たず開催日だけがわかっている会議（ISC High Performance・HOTI・P4 Workshop・Linux Plumbers Conference・情報処理学会 HPC 研究会など）は、種別「開催」の項目としてサイトと `upcoming.md` に出る。
開催の行は会期の最終日を過ぎるまで既定の表示に残る。
締切も開催日も裏が取れていない会議は、どこにも出さない（`data/extra.yaml` には未確認である旨のコメントだけを残してある）。
国内の研究会・シンポジウム（`tags: [domestic-jp]`）は通しやすい発表枠として local 源で維持している。サイトの「国内研究会・国内シンポジウムのみ」で絞れる（`?domestic=1`）。

会期は上流では自由文で書かれており、解釈できない書き方のものは開催イベントを作れない。
タイムゾーンが不明な締切は協定世界時として扱う。
上流の誤りはそのまま反映されるので、気づいたときは `data/overrides.yaml` で訂正する。

上流のスキーマが変わればビルドが壊れうる。
その場合も前回のスナップショットから生成が続くため、サイトが即座に空になることはないが、データは古いままになる。
