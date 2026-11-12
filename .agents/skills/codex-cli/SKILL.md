---
name: codex-cli
description: >-
  Run and manage Codex CLI via the 3-tier workflow (Gemini Argon -> Gemini Flash
  subagent -> Codex CLI) with Ponytail anti-overengineering rules for codebase
  research, implementation, refactoring, and verification while preserving Argon weekly quota.
---

# 3階層連携（Argon × Flash × Codex CLI）実行手順

親エージェント（Gemini 4 Argon）の週間リミットを徹底節約しつつ、Ponytail 原則（怠惰なシニア開発者モード）による最小差分と高い設計品質を両立するための実行手順書です。

## 1. 親エージェント（Argon）から Flash サブエージェントへの委任方法

複数ターンのツール呼び出し（Codex 実行・待機・差分確認・再試行・ビルド・コミット・デプロイ等）が発生するタスクでは、親（Argon）は自分でコマンドを連発せず、最初に仕様と完了条件を固めて **`invoke_subagent` を `Model: "flash"` で起動**します。

```json
{
  "TypeName": "self",
  "Model": "flash",
  "Role": "Implementation & Codex Coordinator",
  "Prompt": "（ここに目的・仕様・受け入れ条件・承認済みのGit/デプロイ有無を明記し、codex-cliスキルに従ってPonytail原則の下でCodex CLIによる実装・検証を行い、完了後に本番コードのgit diff全文・テスト結果サマリ・Ponytailスキップ報告を返すよう指示する）"
}
```

- **親（Argon）がやること**:
  1. 要件整理と仕様策定（Ponytail YAGNI 原則に基づき、過剰な抽象化や不要な設定は削ぎ落とす）。
  2. 上記 `invoke_subagent(TypeName: "self", Model: "flash")` を1回呼び出して待機（ターン終了）。
  3. Flash から返ってきた本番コードの `git diff`、検証サマリ、Ponytail スキップ報告をレビューし、過剰コードがないことを確認してユーザーへ報告する（これにより Argon の消費は最小の 2 ターンで完結する）。

---

## 2. Flash サブエージェント（または実行役）による Codex CLI 呼び出し手順

Flash サブエージェントは、以下の制約と手順に従って Codex CLI を駆動します。

### 実行環境と必須制約

- **初回からサンドボックス外で実行する**:
  Codex CLI は `~/.codex`（ChatGPT 認証・セッション管理）への読み書きと OpenAI への通信を行うため、標準サンドボックス内では `Read-only file system (os error 30)` で失敗します。`codex exec` を実行する `run_command` では**初回から `BypassSandbox: true` を指定**してください。
- **Codex 自身のサンドボックスは必ず維持する**:
  - 調査・比較材料の収集・レビューのみ: `--sandbox read-only`
  - 実装・バグ修正・リファクタリング・テスト作成と実行: `--sandbox workspace-write`
  - **禁止**: `--sandbox danger-full-access` や `--dangerously-bypass-approvals-and-sandbox` は絶対に使用しないでください。
- **認証方式の維持**:
  既存の ChatGPT 認証をそのまま使用し、API キー認証への切り替えは行わないでください。

### コマンドの基本形（`-o` オプションでログを遮断）

大量の思考・実行ログでコンテキストを汚さないよう、最終回答のみを `/tmp/codex-last-message.txt` に書き出し、標準出力は `/tmp/codex-run.log` に捨てます。

- **調査・技術比較タスク（読み取り専用）**:
  ```bash
  codex exec --sandbox read-only -o /tmp/codex-last-message.txt '<調査指示>' > /tmp/codex-run.log 2>&1
  ```

- **実装・修正・テストタスク（ワークスペース書き込み可）**:
  ```bash
  codex exec --sandbox workspace-write -o /tmp/codex-last-message.txt '<実装・検証指示>' > /tmp/codex-run.log 2>&1
  ```

  ※ シェルのコマンド置換解釈エラーを防ぐため、プロンプト文字列にバッククォート（`` ` ``）や `$` を含める場合はシングルクォート `'...'` で囲むか、バッククォートを使わずに記述してください。

### Codex プロンプトに含めるべき項目（一括委任）

1. **目的・仕様・受け入れ条件**（親が決定した設計方針・エッジケース条件）
2. **対象範囲と守るべき制約**（関連パス、`.oxlintrc.json` の層境界ルール、既存仕様・テストの維持）
3. **Ponytail 原則（怠惰なシニア開発者モード）の厳守**:
   - 「**書かずに済むコードが最良のコード**（The best code is the code you never wrote）」。
   - **7段階ラダーの適用**: YAGNI（不要なものを作らない）→ 既存再利用（類似関数・型・CSS等の活用）→ 標準機能（JS/TS組み込み）→ ネイティブ機能（ブラウザ/Workers標準API）→ 既存依存関係（既存npmライブラリ）→ ワンライナー → 最小限実装。要求を満たす最初の段階で停止すること。
   - **過剰エンジニアリングの禁止**: 1回限りのロジックのためにラッパー関数や抽象化クラスを作らない。不要な新規ファイルを作成せず、既存ファイルへの局所追加にとどめる。
   - **削らない防衛線（Lazy, Not Negligent）**: 信頼境界の入力バリデーション、データ消失防止、セキュリティ、アクセス制御は絶対に省略しない。
   - **スキップ報告の義務化**: 完了メッセージの末尾に、スキップした不要な処理や設計判断（Skipped / Not needed）を1〜2行で明記すること。
4. **自己検証の徹底**:
   - 完了前に `npm run typecheck`、`npm run lint`、`XDG_CONFIG_HOME=/tmp npm test`、`npm run build` を実行し、失敗した場合は委任内で修正・再テストして解決すること。
5. **エスカレーション条件**:
   - 要件変更や重大なアーキテクチャ変更が必要と判明した場合は、独断で進めず選択肢を報告すること。
6. **簡潔な報告フォーマット**:
   - 変更ファイル一覧、主要な変更内容と行番号、検証コマンドの結果、Ponytailスキップ報告のみを簡潔に報告させる。

---

## 3. 一次検証・修正ループと親（Argon）への報告フォーマット

Codex CLI の実行が完了したら、Flash サブエージェントは以下の手順で一次検証を行い、親（Argon）へ報告します。

1. **最終メッセージの読み取り**:
   `read_file` で `/tmp/codex-last-message.txt` のみを読み取る（`/tmp/codex-run.log` は異常終了時の `tail -n 30` 以外読まない）。
2. **本番コード差分と境界の確認（Ponytail レビュー）**:
   - `git status --short` および `git diff -- src/ worker/ domain/ shared/`（および新規作成ファイル）を確認する。
   - **Ponytail 点検**: 不要な新規ファイル、1回限りのラッパー、既存コードで代替可能な車輪の再発明がないかを確認する。
   - 変更箇所のすぐ外側の呼び出し元や型定義の整合性を必要に応じてピンポイント確認する。
   - 長大なテストファイル（`tests/*.test.ts`）の全文は読まず、`git diff --stat` の確認にとどめる。
3. **テストと修正の再委任（最大2回）**:
   - Codex のサンドボックス制限（Miniflare の `listen EPERM` 等）で `worker.test.ts` が未完走の場合は、Flash サブエージェント側で `XDG_CONFIG_HOME=/tmp npm test > /tmp/test.log 2>&1 && grep -E "^ℹ (tests|pass|fail)" /tmp/test.log` を実行して全件パスを確認する。
   - 問題や過剰コードが見つかった場合、数行の軽微な修正なら直接 `edit_file` で直し、再実装や過剰コードの削ぎ落としが必要なら `codex exec resume --last -o /tmp/codex-last-message.txt '<修正・削除指示>' > /tmp/codex-run.log 2>&1` で最大2回まで再委任する。
4. **承認済み操作の実行（指示がある場合のみ）**:
   - ユーザーからコミット・プッシュ・本番デプロイの明示指示がある場合は、テスト通過後に `git add` / `git commit` / `git push` / `npx wrangler deploy` まで完了させる。
5. **親（Argon）への最終報告に含める内容**:
   親エージェントが追加のツール実行なしで最終品質判断を下せるよう、以下をまとめて返却する：
   - 実装・変更の要約（ファイルパス・行番号付き）
   - **本番コードの主要な差分（または重要な変更コードの抜粋）**
   - `typecheck` / `lint` / `test` / `build`（および指示された git / deploy）の実行結果
   - **Ponytail スキップ報告（不要と判断して作成しなかったファイルや抽象化、残存リスクなど）**

---

## 4. 明示的な承認が必須の操作（禁止事項）

以下の操作は、ユーザーの明示的な指示・承認がない限り、どの階層のエージェントも実行してはなりません。

- 本番環境へのデプロイ（`wrangler deploy`、`npm run deploy`）
- リモート D1 データベースへの書き込み・マイグレーション・破壊的操作（`wrangler d1 ... --remote`）
- リモートリポジトリへのプッシュ（`git push`）
- 認証情報（`.dev.vars` 等）の外部送信や公開
