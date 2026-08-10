# cfp-radar

高性能計算・ネットワーク・システム・人工知能・セキュリティ・データベース・グラフィックス・HCI・理論の国際会議および穴場ワークショップ・ジャーナルについて、論文投稿の締切と開催日を全自動で探知・配信する。
毎日 1 回自動で上流データを取得・自律探索し、ICS / JSON / CSV / Markdown と静的サイトを生成して GitHub Pages で公開する。
サーバも外部サービスも使わず、GitHub の中だけで完結している。

公開先は https://ten82e.github.io/cfp-radar/ である。

## 直近の締切と開催

直近 180 日の締切と開催の表は [upcoming.md](https://ten82e.github.io/cfp-radar/upcoming.md) にある。
締切を持たず開催日だけがわかっている会議も、開催の行としてここに出る。
この README は手書きで、ビルドが書き換えることはない。

## カレンダーを購読する

購読すると、締切がカレンダーアプリに自動で流れ込み、更新も自動で追随する。
以下では代表として全部入りの `all.ics` を例に使う。
分野を絞りたいときは、後述のフィード一覧から別の URL に読み替える。

```
https://ten82e.github.io/cfp-radar/all.ics
```

`all.ics` と分野別フィードには、上流が募集要項を公開した確定の締切だけが入る。
そのため、次回の募集がまだ出ていない時期には主要会議が 1 件も流れてこない。

**分野によっては確定フィードが薄いので、推定フィードの併用を勧める。**
2026-08-09 時点の実測で、高性能計算 (`hpc.ics`) に将来の確定締切を持つ会議は **IPDPS の 1 件だけ**である。
SC・HPDC・ICPP・CLUSTER・PPoPP・Euro-Par・CCGRID・ICS・PACT・SPAA・ICPADS は上流が次回版を持たず、すべて推定扱いになっている。
分野を問わず見ても、収録 224 会議のうち 172 会議は将来の確定締切を持たない。

推定は分野ごとに別フィードへ分けてあるので、高性能計算の利用者は `hpc.ics` と `hpc-estimated.ics` の 2 本を購読すればよい（人工知能の推定まで抱え込む必要はない）。
カレンダーアプリ側で推定のほうを別の色にしておくと区別しやすい。
推定は前年実績からの機械的な外挿であり、確定情報ではない。

### Google カレンダー

1. パソコンのブラウザで https://calendar.google.com を開く。
2. 左側の「他のカレンダー」の右にある「+」を押す。
3. 「URL で追加」を選ぶ。
4. 上の URL を貼り付けて「カレンダーを追加」を押す。
5. 追加後、左側の一覧に現れたカレンダーの名前と色を好みに変える。

スマートフォンのアプリからは追加できない。
先にブラウザで追加すれば、同じアカウントのスマートフォンにも同期される。
Google 側の取得間隔は数時間から 24 時間程度で、こちらからは制御できない。

### Apple カレンダー

macOS の場合。

1. カレンダーアプリを開く。
2. メニューバーの「ファイル」から「新規照会カレンダー」を選ぶ。
3. 上の URL を貼り付けて「照会」を押す。
4. 「自動更新」を「1 時間ごと」に設定し、「通知」は好みに応じて外す。
5. 「OK」を押す。

iOS と iPadOS の場合。

1. 「設定」から「アプリ」、「カレンダー」、「アカウント」と進む。
2. 「アカウントを追加」から「その他」を選ぶ。
3. 「照会するカレンダーを追加」を選ぶ。
4. 上の URL を貼り付けて「次へ」、「保存」と進む。

### Outlook

ブラウザ版の場合。

1. https://outlook.office.com/calendar を開く。
2. 左側の「カレンダーの追加」を押す。
3. 「インターネットから定期受信」を選ぶ。
4. 上の URL とカレンダー名を入力して「インポート」を押す。

デスクトップ版の Outlook では、ブラウザ版で追加したものが同期されるのを待つのが確実である。

## フィード一覧

| フィード | URL | 内容 |
|---|---|---|
| 全部 | `https://ten82e.github.io/cfp-radar/all.ics` | 全分野・全種別の締切と開催日。推定は含まない |
| 高性能計算 | `https://ten82e.github.io/cfp-radar/hpc.ics` | `hpc` 分野のみ |
| ネットワーク | `https://ten82e.github.io/cfp-radar/networking.ics` | `networking` 分野のみ |
| システム | `https://ten82e.github.io/cfp-radar/systems.ics` | `systems` 分野のみ |
| 人工知能 | `https://ten82e.github.io/cfp-radar/ai.ics` | `ai` 分野のみ |
| セキュリティ | `https://ten82e.github.io/cfp-radar/security.ics` | `security` 分野のみ |
| データベース | `https://ten82e.github.io/cfp-radar/db.ics` | `db` 分野のみ |
| グラフィックス | `https://ten82e.github.io/cfp-radar/graphics.ics` | `graphics` 分野のみ |
| HCI | `https://ten82e.github.io/cfp-radar/hci.ics` | `hci` 分野のみ |
| 理論 | `https://ten82e.github.io/cfp-radar/theory.ics` | `theory` 分野のみ |
| 締切のみ | `https://ten82e.github.io/cfp-radar/deadlines.ics` | 投稿・査読応答などの締切だけ |
| 開催日のみ | `https://ten82e.github.io/cfp-radar/events.ics` | 会期の終日イベントだけ |
| 推定・全分野 | `https://ten82e.github.io/cfp-radar/all-estimated.ics` | 前年からの推定で作った締切。確定フィードには混ぜていない |
| 推定・高性能計算 | `https://ten82e.github.io/cfp-radar/hpc-estimated.ics` | `hpc` 分野の推定締切のみ |
| 推定・ネットワーク | `https://ten82e.github.io/cfp-radar/networking-estimated.ics` | `networking` 分野の推定締切のみ |
| 推定・システム | `https://ten82e.github.io/cfp-radar/systems-estimated.ics` | `systems` 分野の推定締切のみ |
| 推定・人工知能 | `https://ten82e.github.io/cfp-radar/ai-estimated.ics` | `ai` 分野の推定締切のみ |
| 推定・セキュリティ | `https://ten82e.github.io/cfp-radar/security-estimated.ics` | `security` 分野の推定締切のみ |

締切のイベントは締切時刻の 30 分前から締切時刻までの予定として作られる。
7 日前・1 日前・3 時間前の 3 本の通知が入っている。
開催日は終日イベントで、通知は付かない。

## 機械可読の出力

エージェントや自作の道具から使う場合は、次の 2 つを見るのが早い。

| ファイル | 用途 |
|---|---|
| `https://ten82e.github.io/cfp-radar/llms.txt` | 各フィードの URL と意味、データの形を 1 枚にまとめた索引。まずここを読む |
| `https://ten82e.github.io/cfp-radar/data.json` | 正規化済みの全データ。会議・版・締切の三層構造。締切時刻は UTC と AoE 表記を併記 |

他に、1 行 1 締切の平坦な表 `data.csv` と、直近 180 日の締切と開催の表 `upcoming.md` がある。

## サイトの使い方（投稿先レコメンド）

公開サイト https://ten82e.github.io/cfp-radar/ の上部の入力欄に、**投稿予定の論文と似た論文**を 1 行 1 本で貼り付けると、合いそうな会議・ジャーナルを適合度順にランク付けする。

```
投稿予定: Credit-Based Shaping for Deterministic Latency in TSN | TSN, CBS, latency, scheduling
似た論文: Design and Analysis of Credit-Based Shapers in TSN | TSN, CBS, QoS | RTSS
```

- 各行の形式は `タイトル | キーワード | 掲載先(任意)`。掲載先が分かっている「似た論文」にはタグを付けると、その会議が「掲載先一致」として優先される（タグ無しの投稿予定論文は内容だけからマッチする）。タグは `SC` のような 2 文字の略称も対応（正確に一致した会議のみ）。
- 分野チップが空のときは論文内容から分野を自動判定して表示する（手動でチップを選ぶとその分野に絞る）。
- 英語・日本語どちらのタイトル/キーワードにも対応。日本語の場合は会議名の日本語表記と部分一致し、国内研究会（情報処理学会・電子情報通信学会等）も拾う。
- **AI セマンティック補助**: 会議スコープは build 時に all-MiniLM-L6-v2 で埋め込み済み（`embeddings.json`）。ブラウザで transformers.js が使える環境では、論文入力の埋め込みとコサイン類似度を計算し、語彙スコア（70%）と AI 類似度（30%）を合成する。CDN が使えない環境では語彙スコアのみで動作（フォールバック）。
- 適合度は、分野シグナル・会議名・領域タグとの語彙一致と掲載先タグの合算。スコアリングの実装は `site/recommender.js` で、`tests/test_recommender.py` が実データで回帰検証する。

## データ源とライセンス

| 名前 | リポジトリ | ライセンス |
|---|---|---|
| `ccfddl` | [ccfddl/ccf-deadlines](https://github.com/ccfddl/ccf-deadlines) | MIT |
| `aideadlines` | [huggingface/ai-deadlines](https://github.com/huggingface/ai-deadlines) | MIT |
| `local` | 本リポジトリの `data/extra.yaml` | MIT（本リポジトリ） |

発見ソース（候補生成）: `DBLP`・`OpenReview`・`wikiCFP`（70 カテゴリ）・`DBWorld` メーリス公開アーカイブ（[dbworld.sigmod.org](https://dbworld.sigmod.org/)）・`EasyChair` Smart CFP（[easychair.org/cfp](https://easychair.org/cfp/)）・購読メーリス `IMAP`（任意）・`IEEE ComSoc 誌特集号`（IEEE TNSM/TCCN/Network/Communications Magazine/Wireless Communications のオープン特集号 CFP）。DBWorld は購読不要の公開アーカイブで、wikiCFP に載らない併設ワークショップ・ジャーナル特集号・締切延長通知を拾う。EasyChair は運営者が登録した構造化 CFP（締切・場所・トピック）で、分野フィルタ適用済み。IMAP は GitHub Secrets（`CFP_IMAP_HOST`/`CFP_IMAP_USER`/`CFP_IMAP_PASS`）を設定すると受信トレイ直近 50 通から CFP メールを抽出する（未設定ならスキップ）。候補は締切を公式サイトで裏取りした後、`data/extra.yaml` に昇格する。

上流が扱わない会議は `data/extra.yaml` に自前で収録している。
帰属表示は [NOTICE.md](NOTICE.md) にある。
本リポジトリ自体のライセンスは MIT で、全文は [LICENSE](LICENSE) にある。

## 穴場の会議・ジャーナルの探索

上流に登録されていない特化ワークショップ、地域シンポジウム、ジャーナルの Call for Papers などの「穴場」を自律探索するには以下を実行する。

```sh
env -u PYTHONPATH .venv/bin/python -m scripts.cli discover --dry-run
```

探索結果を `extra.yaml` スキーマ互換の YAML に保存する場合:

```sh
env -u PYTHONPATH .venv/bin/python -m scripts.cli discover --out data/discovered_candidates.yaml
```

`--append` を付けると既存の候補を保持したまま key 重複なしで追記する。
`.github/workflows/update.yml` の `discover-candidates` ジョブが毎日これを実行し、
`data/discovered_candidates.yaml` に候補を溜めていく。

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
その日は前回配信した内容がそのまま残る（縮退した内容で上書きすると、購読者のカレンダーから予定が消えるため）。

自動コミットは `github-actions[bot]` 名義で、メッセージに `[skip ci]` が付く。

公開リポジトリでは、60 日間リポジトリの活動が無いとスケジュール実行が自動で無効化される（[GitHub の公式文書](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)）。
対策は上のスナップショット更新の副次効果だけである。
bot のコミットが「活動」に数えられるかは公式文書に記載が無く、この対策が効くかは未検証である。
活動を偽装する目的のコミットは、利用規約違反として停止された前例があるため実装しない。
停止された場合は、リポジトリの Actions タブから `update` ワークフローを開き、`Run workflow`（`workflow_dispatch`）で手動実行すると再び有効になる。

`.github/workflows/ci.yml` は push と pull request で動く。
`test` ジョブは `tests/fixtures/` だけを源とするネットワーク非依存の検証で、これは必須である。
`smoke` ジョブは実際の上流を取りに行くが、上流障害で赤くならないよう必須にしていない。
なお ci.yml は `paths-ignore` を使っており、`data/snapshot.json` だけを変えるコミットではジョブがスキップされる。
スキップされたジョブは必須チェック（required check）として Pending のまま残るため、ブランチ保護を掛ける場合はこれらを必須チェックに指定しない。

### 初回セットアップ

`update.yml` はカスタムワークフローから Pages に配信するため、リポジトリの設定が必要である（[GitHub の公式文書](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)）。
Settings の Pages を開き、Build and deployment の Source を「GitHub Actions」にする。
既定のままだと Deploy の段階で毎日失敗する。

## 手元で動かす

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt -r requirements-dev.txt
.venv/bin/python -m scripts.cli build --out public
```

`public/index.html` をブラウザで開けばサイトを確認できる。

テストを走らせる。

```sh
.venv/bin/pytest -q
```

その他の指定。

| 指定 | 意味 |
|---|---|
| `--config config.yaml` | 設定ファイルの位置 |
| `--out public` | 出力先 |
| `--now 2026-08-09T00:00:00Z` | 基準時刻を固定する。同じ入力で出力が一致することを確かめたいときに使う |
| `--cache .cache` | 上流の取得結果を置く場所 |
| `--offline` | 上流を取りに行かず、キャッシュ、それも無ければ `data/snapshot.json` を使う |

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

推定締切は前年の同種の締切から機械的に作ったものである。
`all.ics` や分野別フィードには入れず、`all-estimated.ics` と分野別の推定フィードにだけ出している。
サイト上でも推定であることを明示している。
根拠のない締切を本体のフィードに混ぜない方針を採っている。

締切を持たず開催日だけがわかっている会議（ISC High Performance・HOTI・P4 Workshop・Linux Plumbers Conference・情報処理学会 HPC 研究会など）は、種別「開催」の項目としてサイト・`upcoming.md`・`events.ics` に出る。
開催の行は会期の最終日を過ぎるまで既定の表示に残る。
締切も開催日も裏が取れていない会議は、どこにも出さない（`data/extra.yaml` には未確認である旨のコメントだけを残してある）。
国内の研究会・シンポジウム（`tags: [domestic-jp]`）は通しやすい発表枠として local 源で維持している。サイトの「国内研究会・国内シンポジウムのみ」で絞れる（`?domestic=1`）。

会期は上流では自由文で書かれており、解釈できない書き方のものは開催イベントを作れない。
タイムゾーンが不明な締切は協定世界時として扱う。
上流の誤りはそのまま反映されるので、気づいたときは `data/overrides.yaml` で訂正する。

上流のスキーマが変わればビルドが壊れうる。
その場合も前回のスナップショットから生成が続くため、サイトが即座に空になることはないが、データは古いままになる。
