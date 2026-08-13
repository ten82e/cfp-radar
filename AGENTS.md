# cfp-radar

HPC・ネットワーク・システム・AI・セキュリティ会議・穴場ワークショップの締切を ICS/JSON/Pages で自動探知・配信する。
実装の正は `SPEC.md`。購読手順は `README.md`。

## 検証

```sh
npm ci
npm run typecheck
npm run check       # biome lint
npm test            # vitest
node src/cli.ts build --out public --offline --cache .cache --now 2026-08-09T00:00:00Z
```

- `public/` は `.gitignore`（CI が生成）。`data/snapshot.json` は健全な online ビルドが更新する。
- offline ビルドは snapshot を書かない（fixtures 汚染防止）。実キャッシュ成果を snapshot に載せるときは手でコピー。

## 収録の契約

- `taxonomy.*.venues` に書いた会議は **rank_filter を迂回して必ず残る**（名指し＝収録意思）。
- 上流に無い会議は `data/extra.yaml`。上流の誤りは `data/overrides.yaml`。
- 締切の推測はしない。公式で裏が取れた日付だけ。

## 禁止（ユーザー指示 2026-08-11）

- **https://ccfddl.com/ をフォーク・複製（パクり）するブランチは作らない**。cfp-radar は
  独自名・独自 UI の独立プロジェクト。ccfddl/ccf-deadlines の GitHub リポジトリは
  「上流データソース」としてだけ扱う。**第三者に届く送信は一切絶対禁止** — 上流に限らず、
  PR・issue・コメント・レビュー返信・リアクション・既存 PR の再オープン・fork
  （ten82e/ccf-deadlines）への push・メール・問い合わせフォーム・SNS すべて
  （2026-08-12 指示「還元 PR とかで迷惑かけるのは絶対にやめて」。要確認ですらない。
  #1629〜#1633 の無断連投を受けての改定）。上流の誤り・欠落は `data/overrides.yaml` /
  `data/extra.yaml` で自前吸収する。`upstream-patches/` は過去の記録として残すだけで、
  新規に送ることはない。
- フォーク用途の `~/ccf-deadlines` は停止済み・放置（触らない・コミットしない）。
- このリポジトリは `origin = ten82e/cfp-radar`（フォークではない）を維持する。

## レッスン

`~/.hermes/skills/research/autonomous-research-loop/references/project-lessons/conf-deadlines.md`

---

## IDD ワークフロー

このプロジェクトは Issue-Driven Development (IDD) を採用している。

- クロスエージェントの入り口とフェーズ振り分け: **`docs/idd-workflow.md`**
- ローカル方針（merge / review / CI / claim / 禁止事項）: **`docs/idd-cfp-radar-policy.md`**
- IDD 作業を始める前に: `.github/instructions/idd-overview-core.instructions.md` を開き、
  現在のフェーズが変わったら該当フェーズファイルを手で開くこと。
- 収録の契約・禁止節は IDD でもそのまま有効。IDD の activity は `ten82e/cfp-radar` 内部のみ。

## 起動時プロローグ（IDD）

このリポジトリの自律実行は **IDD の Discover → Claim → Work → PR → CI →
Review → Merge** を唯一のループとする。`autonomous-research-loop` はこの
リポジトリの起動時・各ターンに自動注入しない。調査・実装を続ける場合も、
必ず既存の GitHub Issue（または明示された Issue URL/番号）に紐付ける。

1. `docs/idd-workflow.md` と `.github/idd/config.json` を読む。
2. 現在のリポジトリの open Issue を Discover する。
3. startable な Issue が 0 件なら、候補なしを報告して停止する（Issue の
   自動作成、無関係なビルド調査、無制限のリサーチ再開は行わない）。
4. Issue を選んだら、状態に対応する `.github/instructions/idd-*.instructions.md`
   を読み、claim 証拠を作ってから作業する。
5. すべての変更はこのリポジトリ内だけで行い、上記の外部送信禁止を守る。

Freebuff 等の継続実行ハーネスを使う場合もこの停止条件を継承する。
キューが空になったときに同じ調査を繰り返さず、次の Discover ラウンドで
Issue が現れるまで待機する。

## IDD execution policy

This repository uses the imported Issue-Driven Development (IDD) loop in
`.github/instructions/`. The selected policy is `fully_autonomous_merge`
with `no-advisory`: IDD may merge a ready PR automatically, but it never
requests or waits for a Copilot/advisory review. CI, branch state, required
reviews configured outside IDD, unresolved conversations, claim ownership,
and review-watermark freshness remain merge gates.

Start each IDD session with [`docs/idd-workflow.md`](docs/idd-workflow.md)
and then open the phase file matching the current issue/PR state. When no
startable open Issue exists, Discover is a terminal no-candidate result; do
not substitute autonomous research or an unrelated debugging task.

IDD actions are limited to this repository's own Issues, branches, and PRs.
The upstream/no-contact rules above remain authoritative and must not be
weakened by the IDD loop.
