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
  「上流データソース」としてだけ扱い、改善点は上流 PR で還元する（#1622 済み・#1624/#1628 等）。
- フォーク用途の `~/ccf-deadlines` は停止済み・放置（触らない・コミットしない）。
- このリポジトリは `origin = ten82e/cfp-radar`（フォークではない）を維持する。

## レッスン

`~/.hermes/skills/research/autonomous-research-loop/references/project-lessons/conf-deadlines.md`

---

## 起動時プロローグ（自走ループ再注入）

ユーザーが別の指示を出すまで、`autonomous-research-loop` に従い自走を継続せよ。

1. `python3 ~/.hermes/scripts/research-loop-advance.py --status`
2. Obsidian ノート `Claude/memory/research-loop-conf-deadlines-20260809.md` の「次の問い」から再開
3. このリポジトリ（`/Users/ten82e/conf-deadlines`）に留まる。他リポジトリへ移らない
4. 知見はノートに書け。停止時は問い・既知・次の問いを残す
5. 実装で正せる残差が 0 でも、公式 CFP の突合・上流 PR・Pages 公開状態は定期再確認

公開（未実施なら）:

```sh
git add -A && git commit -m "..."
gh repo create ten82e/cfp-radar --public --source=. --remote=origin --push
# Settings → Pages → Source = GitHub Actions
gh workflow run update.yml
```

上流 PR 追跡: https://github.com/ccfddl/ccf-deadlines/pull/1622
