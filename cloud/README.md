# 講習スケジュール（Cloudflare 版）

Google フォームの代わりに、講師が自分の予定をカレンダーで入力するページと、事務用の管理画面です。
Cloudflare Workers + D1（データベース）の無料枠で動きます。

- 講師ページ `/`：Google でログイン → 講師登録（事務の承認制）→ 講習ごとに来られるコマをタップして提出。何度でも修正可
- 管理画面 `/admin`：講習（期間・時限・休校日）の作成、講師の承認、提出状況、予定変更の通知、事務アカウントの管理
- 今のアプリ（Flask 版）へのつなぎ：管理画面の「今のアプリ用CSVをダウンロード」→ 今のアプリの「予定表ファイルを取り込む」

## ローカルで動かす

```bash
cd cloud
npm install
cp .dev.vars.example .dev.vars   # SESSION_SECRET を長いランダム文字列にする
npm run db:migrate:local
npm run dev                      # http://localhost:8787
```

`.dev.vars` で `DEV_LOGIN=1` にしておくと、ログイン画面の下に「開発用ログイン」が出て、Google を使わずに好きなメールアドレスでログインできます（localhost のときだけ有効）。
`ADMIN_EMAILS` に書いたアドレスでログインすると管理画面に入れます。

## 公開する（初回だけ）

### 1. Cloudflare

1. https://dash.cloudflare.com/sign-up で無料アカウントを作る
2. `npx wrangler login`
3. `npx wrangler d1 create juku-scheduler` を実行し、表示された `database_id` を `wrangler.toml` に書き換える
4. `npm run db:migrate:remote`
5. `npm run deploy` → `https://juku-scheduler.<アカウント名>.workers.dev` が表示される（以下「公開URL」）

### 2. Google ログインの設定（無料）

1. https://console.cloud.google.com/ でプロジェクトを作る
2. 「APIとサービス」→「OAuth 同意画面」：ユーザーの種類は「外部」、アプリ名・サポートメールを入力し、**公開ステータスを「本番環境」にする**（テスト中のままだと、登録したテストユーザーしかログインできない）。スコープは email / profile / openid のみなので審査は不要
3. 「認証情報」→「OAuth クライアント ID を作成」→ 種類「ウェブ アプリケーション」
   - 承認済みのリダイレクト URI：`公開URL/auth/callback`
4. 表示されたクライアント ID とシークレットを登録する

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET   # 長いランダム文字列（例: openssl rand -base64 32 の結果）
npx wrangler secret put ADMIN_EMAILS     # 最初の事務アカウント（カンマ区切り）
```

**本番には `DEV_LOGIN` を絶対に設定しないこと。**

### 3. 使い始める

1. `公開URL/admin` に事務アカウントでログイン →「新しい講習を作る」
2. 講師に `公開URL` を LINE などで共有する（全員同じリンク）
3. 登録してきた講師を「講師」タブで承認し、comiru 講師ID を入れておく（第3段階の comiru 登録で使う）

## 更新するとき

```bash
npm run db:migrate:remote   # migrations/ に新しいファイルを足したときだけ
npm run deploy
```

## 今後の予定

1. ✅ 講師の入力ページ（この段階）
2. 管理画面の割り当て機能・生徒の予定入力を移す（今の Flask 版の置き換え）
3. comiru への直接登録（全体 / 生徒ごと、追加・変更・削除の反映）
