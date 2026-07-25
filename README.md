# X自動投稿ボット（管理栄養士×家計再生アカウント用）

毎日、曜日に応じて以下を自動生成しXに投稿します。

- 月・水・金：knowledgeポスト（テキストのみ）
- 火・木・土：クイズ投稿（HTML→画像化した3枚スライド＋キャプション、リプライで連結）
- 日：会話誘発ポスト（テキストのみ）

トピックの重複は `scripts/topics_log.json` で管理し、投稿のたびに自動更新されます。

---

## セットアップ手順

### 1. GitHubリポジトリを作成

このフォルダの中身をそのまま新しいGitHubリポジトリにpushしてください。

```bash
git init
git add .
git commit -m "initial commit"
git branch -M main
git remote add origin https://github.com/あなたのユーザー名/リポジトリ名.git
git push -u origin main
```

### 2. Anthropic APIキーを取得

1. https://console.anthropic.com/ にログイン
2. 「API Keys」からキーを発行

### 3. X APIキーを取得（OAuth 1.0a、投稿権限が必要）

1. https://developer.x.com/ でDeveloperアカウントを作成し、プロジェクト／アプリを作成
2. アプリの権限を **Read and Write** に設定（デフォルトはRead Onlyなので要変更）
3. 以下の4つを取得
   - API Key（Consumer Key）
   - API Key Secret（Consumer Secret）
   - Access Token
   - Access Token Secret
   - ※Access Token / Secretは「Read and Write」権限に変更した**後**に再生成する必要があります（変更前に発行したものは権限が古いままです）

### 4. GitHub Secretsに登録

リポジトリの `Settings → Secrets and variables → Actions → New repository secret` から、以下5つを登録してください。

| Secret名 | 値 |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropicで発行したキー |
| `X_API_KEY` | XのAPI Key |
| `X_API_SECRET` | XのAPI Key Secret |
| `X_ACCESS_TOKEN` | XのAccess Token |
| `X_ACCESS_SECRET` | XのAccess Token Secret |

### 5. ローカルで動作確認（推奨）

本番投稿の前に、一度ローカルで動かして正しく投稿できるか確認してください。

```bash
npm install
export ANTHROPIC_API_KEY=xxxx
export X_API_KEY=xxxx
export X_API_SECRET=xxxx
export X_ACCESS_TOKEN=xxxx
export X_ACCESS_SECRET=xxxx
npm run post
```

### 6. GitHub Actionsを有効化

`.github/workflows/daily_post.yml` がリポジトリにpushされていれば、毎日 JST 8:00 に自動実行されます。
「Actions」タブから `workflow_dispatch` で手動実行してテストすることもできます。

---

---

## おまけ機能：返信下書きの自動提案（Issue経由）

自分のアカウントへの自動投稿とは別に、「関連する投稿を見つけて、返信の下書きだけ提案する」機能もあります。
**実際の返信送信は行いません**（Xの自動化ポリシー上のリスクを避けるため）。あなたがGitHubのIssueを見て、良ければ手動でXから返信する運用です。

### 追加で必要なもの

| Secret名 | 値 |
|---|---|
| `X_BEARER_TOKEN` | X Developer Portalの「Keys and tokens」→「Bearer Token」 |

`ANTHROPIC_API_KEY`は投稿用と共通のものを使います。

### 動作

- 毎週月曜 JST 8:00 に自動実行（`.github/workflows/engagement_drafts.yml`）
- `scripts/find_engagement_targets.js`内の`SEARCH_QUERY`に一致する投稿を検索
- 上位5件（`MAX_CANDIDATES`で変更可）について、Claudeが返信下書きを生成
- リポジトリの「Issues」タブに`【返信下書き提案】YYYY-MM-DD`という形式で一覧が投稿される
- 提案済みのツイートIDは`scripts/engagement_log.json`に記録され、重複提案を防止

### 使い方

1. 週1回、Issueを開いて内容を確認
2. 気に入った下書きがあれば、記載されたURLからそのツイートを開き、**手動で**返信を送信
3. 検索条件やトーンを変えたい場合は`SEARCH_QUERY`や`PERSONA`を編集してpush

### コストについて

X APIの検索（読み取り）は$0.005/件かかります。1回の実行で最大20件読み取るため、週1回の実行で月あたり約$0.4程度の想定です。

---

## 運用上の注意

- **X APIは従量課金**です（投稿1件$0.015、リンク付きは$0.20）。クレジットカード登録と、事前のクレジット購入が必要です。
- **投稿トーンの調整**：`scripts/generate_and_post.js` 内の `PERSONA` 定数を編集すると、口調やペルソナ設定を調整できます。
- **画像デザインの調整**：`templates/quiz_template.html` の色・フォント・レイアウトを編集すると見た目を変えられます。
- **投稿タイプの曜日割り当て変更**：`generate_and_post.js` 内の `POST_TYPE_BY_DAY` を編集してください。
- 初回運用時は、想定と違う投稿がされていないか毎日目視でチェックすることを強くおすすめします。慣れてきたら放置で問題ありません。
- Xの自動化アカウントには、プロフィールへの「Automated」ラベル表示など運用ルールがある場合があります。X Developer Agreementを確認のうえ運用してください。
