# IDD Policy Configuration — cfp-radar

このリポジトリ（`ten82e/cfp-radar`）の IDD (Issue-Driven Development)
ワークフローは、`kurone-kito/idd-skill` の portable template を
オンボーディングしたものである。本ファイルは Step 3 のローカル方針記録
であり、`.github/idd/config.json` と整合する。将来の IDD セッションは
このファイルを読み、ここに記録された方針に従うこと。

- 入り口: `docs/idd-workflow.md`（クロスエージェント経路・フェーズ振り分け）
- 共有定義: `.github/instructions/idd-overview-core.instructions.md`
- マシン可読ポリシー: `.github/idd/config.json`

## Merge Policy

**Policy**: `fully_autonomous_merge`

信頼された 1 エージェントセッション（オペレータ自身が走らせるセッション）が、
claim・freshness・CI・レビュー・スレッドの各ゲートを通過した後に F3 の
マージ実行まで継続できる。`human_merge` / `separate_merge_agent` への
明示的オプトアウトは行わない（ユーザー指示 2026-08-13）。

**Credential Scope**: ワーカーセッションとマージ可能セッションは同一
（`fully_autonomous_merge` の既定）。マージは `gh` の認証済みアカウント
（`ten82e`）で行う。`docs/permissions.md` の最小特権の原則に従う。

## PR Review Policy

**Profile**: `no-advisory`

IDD 管理下の advisory レビュアー（GitHub Copilot 等）は**一切**
リクエスト・待機・回復しない。理由:

- このリポジトリはマージを CI・ブランチプロテクション・未解決スレッド・
  freshness・claim 証拠だけでゲートする方針を選択した。
- AGENTS.md の「禁止（ユーザー指示 2026-08-11 / 2026-08-12）」により、
  第三者への送信は一切禁止。Copilot レビュー依頼は GitHub 外部サービス
  へのレビュアー追加を伴うため、これにも抵触し得る。IDD の PR/Issue/
  コメント活動は ten82e/cfp-radar 内部のみ（下記「外部送信の禁止」節）。

適用済みアーティファクト: `profiles/no-advisory/README.md`

変更したフェーズファイル（E14 / F2 / F3 の advisory 経路を除去）:

- `.github/instructions/idd-review-fix.instructions.md` — E14 は人間
  レビュアーの再レビュー依頼のみ。advisory bot リクエスト・
  `advisory-wait` 系マーカー・ポーリングループを削除。
- `.github/instructions/idd-advisory-wait.instructions.md` — 本プロファイル
  では不使用と明記（ファイルは参照・再インポート差分用に維持）。
- `docs/idd-advisory-wait-shell-fallback.md` — 同上。
- `.github/instructions/idd-pre-merge.instructions.md` — F2 の
  `Advisory bot wait` / `Advisory convergence` チェックを
  「ポリシーにより満たされた」に置換。
- `.github/instructions/idd-merge.instructions.md` — F3 の advisory
  state revalidation と gate checklist の advisory 項目を除去。
- `.github/instructions/idd-review-snapshot.instructions.md` — CI 完了
  前提条件から advisory 再レビュー前提を除去。人間コメントは従来どおり
  スコープ内。
- `.github/instructions/idd-review-triage.instructions.md` —
  Zero-Accepted-PATH-A advisory re-review gate と courtesy-ack
  convergence を no-op と明記（PATH B は advisory が不在のため発生しない）。
- `docs/idd-review-policy-profiles.md` — 採用プロファイルを記録。

**Human review rule outside IDD**: IDD 外の人間レビュー規則（CODEOWNERS、
required reviews、branch protection）は GitHub 側設定に委ねる。現時点では
未設定（下記「Up-to-Date-Head Ruleset」参照）。

## Review-Thread Resolution Policy

**Policy**: `fast-agent-resolve`（分散既定）

エージェントが受領したフィードバックを修正・却下（根拠付き）・PATH B
処理した後、スレッドを解決できる。「エージェントが対処した」ことであり
「レビュアーが同意した」ことではない。

## Critique-Loop Profile

**Profile**: distributed defaults（`docs/policy-constants.md` の既定値。
カスタムなし）

## Claim Timing

- **claim-stale-age**: `PT24H` / 24 h（分散既定）
- **claim-heartbeat-interval**: `PT12H` / 12 h（分散既定）

## CI Wait Policy

- **running timeout**: `PT30M` / 30 min（分散既定）
- **generation timeout**: `PT10M` / 10 min（分散既定）
- **rerun policy**: `rerun-once`（分散既定）

## Up-to-Date-Head Ruleset

**Policy**: `disabled`（推奨値）— 現時点で当リポジトリの ruleset は
「merge 前に main と同期必須」を要求していない（設定なし）。これを
有効化すると BEHIND のたびに main-sync merge を強制され、advisory
ラウンドが増えるだけでレビュー価値がないため、無効を維持する
(kurone-kito/idd-skill#1817)。

## Required-Check Registration

- **Classic-API `contexts` pinning trap avoided**: yes / not applicable —
  IDD 専用チェック（`idd-advisory-convergence` 等）はホストしていない
  （no-advisory）。required check は GitHub 側の通常設定に従う。
- **Producer-identity choice**: not applicable。

## Issue-Author Approval Gate

- **Gate posture**: `enabled-by-default`（オプトアウトしない）
- **Opt-out state**: `skipIssueAuthorApprovalGate` は設定しない
- **`maintainer-approval-actors` policy**: `owners-and-maintainers-only`
- **Approval signals**: オペレータ（`ten82e` = owner）自身が著者である
  issue は self-authorizing。外部者が書いた issue は承認ラベルまたは
  明示的な maintainer 承認コメントが必要。
- **Missing-approval behavior**: 承認なしの明示ターゲットは claim 前に
  停止。Discover は承認待ち issue を approval-needed フォールバック
  バケットに入れる。

## Issue-Authoring Companion

**Status**: repository-local policy installed at
`docs/issue-authoring-skill.md`; the external helper bundle is not vendored.

## Helper Runtime Profile

**Profile**: `instructions-only`

ヘルパースクリプト（`post-idd-marker` / `advisory-wait-state` /
`idd-doctor` 等）はベンダーせず、`devDependency` にも追加しない。
`.github/idd/config.json` の `helperRuntime.profile` を
`instructions-only` に設定済み。全フェーズは手動 `gh`/`gh api` の
フォールバックで実行する。

**備考**: リポジトリは npm（`package-lock.json` あり）なので、将来
ヘルパーを導入する場合は `package-manager` プロファイルへの変更が
自然だが、オペレータ確認なしに変更しないこと。

## Freebuff 継続実行契約

Freebuff の Auto は、IDD の外側の作業を発明するための機能ではなく、
キューに入った IDD ターンを継続するためだけに使う。キューが空になった
ときの Discover は次の順序で行う。

1. 新しい具体的な作業候補がある場合だけ、`docs/issue-authoring-skill.md`
   の `state=all` 重複検索を先に実行する。
2. 既存Issueで吸収できない場合に限り、`status:authoring` 付きIssueを作成し、
   受入条件とSuitability footerを検証する。
3. authoring hold中はclaimしない。Freebuff の自律実行契約が release checklist と
   suitability floor を検証した後に自動でラベルを外し、`idd-discover` →
   `idd-claim` → 現在フェーズの指示へ進める。検証失敗時はholdを維持する。
4. 作業候補もstartable Issueも無ければ「候補なし」で停止し、同じ調査を再実行しない。
5. `autonomous-research-loop` の再注入、Issue外のビルド調査、ダミーIssueの量産は行わない。

Freebuff 側では `autonomous-research-loop` のスキル注入を無効のまま維持し、
Auto のスコープは IDD の Discover が制御可能な範囲（Focused/Balanced）に
留める。リポジトリの open Issue が 0 件であること自体は正常な待機状態で
あり、キューを埋めるためのダミー作業やIssueを作らない。1回のauthoring
セッションで作成する新規Issueは、roadmap分解が明示的に必要な場合を除き1件までとする。

## Obsidian と Issue の役割

Obsidianの既存ノートは履歴・参照用であり、IDDの状態管理には使わない。
新しい問い、候補、ブロッカー、受入結果、完了リンクはGitHub Issue/PRへ
記録する。Issue本文・コメント・PRが、他セッションから追跡可能な正本である。

## IDD Label Names

- **roadmap label**: `roadmap`（分散既定）
- **blocked-by-human label**: `status:blocked-by-human`（分散既定）
- **needs-decision label**: `status:needs-decision`（分散既定）

当リポジトリにセマンティック auto-labeler（CodeRabbit 等）は導入していない。
導入する場合は reserved-label guard recipe
（`docs/customization.md`）を先に適用すること。

## Bootstrap Execution Mode

**Mode**: `direct-import` core + bounded Issue authoring (2026-08-13).
Initial onboarding was imported directly to `main`; subsequent work uses
Issue -> automated release checklist -> claim -> PR -> CI -> autonomous merge.

## Placeholder Values（オンボーディング確定値）

| Placeholder (template token) | Value |
| --- | --- |
| `REPO_NAME` | `cfp-radar` |
| `PROJECT_MARKER_PREFIX` | `cfp-radar`（`^[a-z][a-z0-9-]{1,31}$` 適合） |
| `TRUSTED_MARKER_ACTOR` | `ten82e` |
| `INSTALL_DEPS_COMMAND` | `npm ci` |
| `FIX_VALIDATE_COMMANDS` | `npm run format && npm run check` |
| `PRE_PUSH_VALIDATE_COMMANDS` | `npm run typecheck && npm run check && npm test` |
| `POST_FIX_VALIDATE_COMMANDS` | `npm run typecheck && npm run check && npm test` |

`issue-scope` は `roadmap-first`、`orphan-first-policy` は `none`（分散既定）。

## 外部送信の禁止（cfp-radar 固有の拘束）

AGENTS.md「禁止（ユーザー指示 2026-08-11 / 2026-08-12）」は IDD
セッションにも**そのまま適用される**:

- **第三者に届く送信は一切絶対禁止**。上流（ccfddl / ccf-deadlines）
  に限らず、他リポジトリ・他アカウントへの PR・issue・コメント・
  レビュー返信・リアクション・既存 PR の再オープン・fork への push・
  メール・問い合わせフォーム・SNS すべて禁止。
- IDD の activity は **`ten82e/cfp-radar` 内部のみ**：このリポジトリの
  issue の claim コメント、PR のレビュー対応・digest 更新・マージ、
  F4 のクリーンアップ等は対象内。
- 上流の誤り・欠落は従来どおり `data/overrides.yaml` /
  `data/extra.yaml` で自前吸収する。`upstream-patches/` は過去の記録として
  残すだけで、新規送付はしない。
- このリポジトリは `origin = ten82e/cfp-radar`（フォークではない）を維持。
  IDD は fork を前提としない（同一リポジトリ内のブランチ/ワークツリーで
  完結）。

## 収録の契約（IDD と併用）

- `taxonomy.*.venues` に名指しした会議は rank_filter を迂回して必ず残る。
- 上流に無い会議は `data/extra.yaml`、上流の誤りは `data/overrides.yaml`。
- 締切の推測はしない。公式で裏が取れた日付だけ。
- IDD の変更でもこの契約は変わらない。deadline 修正 PR の検証コマンドは
  `npm run typecheck && npm run check && npm test`（AGENTS.md 検証節）。
  スナップショット更新は online ビルド（CI 20:17 UTC）が行うため、
  `data/snapshot.json` は PR で手動更新しない。

## Worktree Guard

**Status**: disabled（`.githooks/` は同梱のみ。`worktreeGuard.enabled` は
設定しない）。有効化する場合のみ `git config core.hooksPath .githooks`
を各クローンで実行する。

## Lite Profile

**Status**: not enabled（`.github/instructions/lite/` は同梱のみ）。
`liteProfile` を有効化する場合は、lite 版フェーズファイルにも
no-advisory の同等編集が必要になる点に注意。

## 検証コマンド

```sh
npm ci
npm run typecheck
npm run check
npm test
```

IDD の変更（コード・データ・ドキュメント）は push 前に
`npm run typecheck && npm run check && npm test` を通すこと
（`pre-push-validate` / `post-fix-validate` 行に同一コマンドを設定済み）。

## 検証エビデンス（no-advisory profile）

- オンボーディング差分: 本ファイル + 上記フェーズファイル + `.github/idd/config.json`
  （`reviewPolicy: "no-advisory"`）でレビュー済み。
- `idd-onboard --verify` と `idd-doctor --json` を `instructions-only` プロファイルで実行し、
  必須ファイル・プレースホルダー・設定スキーマ・エントリーファイルの検査は PASS。
  doctor の警告は `ten82e/cfp-radar:main` のブランチ保護情報を GitHub API から読めない点だけ。
- 2026-08-13 の Discover 検査では `ten82e/cfp-radar` の open Issue は 0 件。
  したがって、IDD/Freebuff は候補なしで停止するのが正しい状態である。
- Issue authoring is reuse-first and hold-based: existing Issues are extended
  before new creation, new drafts carry `status:authoring`, and release is an
  explicit operator boundary.
- 初回 IDD PR で、advisory レビュアーがリクエストされず、CI と未解決
  スレッドがマージゲートとして機能することを PR 状態で確認する。
  エビデンスが取れたらこの節を更新する。

## Completion Note

```markdown
PR review policy profile: no-advisory
Reason: CI・ブランチプロテクション・未解決スレッドのみでゲートし、
advisory レビュアーは使わない方針（外部送信禁止の AGENTS.md 指示とも整合）。
Branch protection rule: 現状未設定（GitHub 側で設定する場合に追記）
Review-thread resolution profile: fast-agent-resolve
Verification evidence: 本ファイル「検証エビデンス」節
Profile artifact applied: profiles/no-advisory/README.md
```
