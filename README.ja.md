[English](./README.md) | 日本語 | [한국어](./README.ko.md) | [繁體中文](./i18n/README-TW.md) | [简体中文](./i18n/README-ZH.md)

<p align="center">
<picture>
<source media="(prefers-color-scheme: dark)" srcset="./assets/brand/readme/cuttlely-readme-header-dark.png">
<img src="./assets/brand/readme/cuttlely-readme-header-light.png" alt="Cuttlely。あなたのアプリケーションに、エージェントを。アプリケーションのためのオープンソースのエージェントプラットフォーム。" width="880">
</picture>
</p>

# Cuttlely

[![Release](https://img.shields.io/github/v/release/cuttlely/cuttlely)](https://github.com/cuttlely/cuttlely/releases/latest)
[![License](https://img.shields.io/github/license/cuttlely/cuttlely)](https://github.com/cuttlely/cuttlely/blob/main/LICENSE.md)
[![Docker image](https://img.shields.io/badge/ghcr.io-cuttlely%2Fcuttlely-2496ED?logo=docker&logoColor=white)](https://github.com/cuttlely/cuttlely/pkgs/container/cuttlely)
[![npm](https://img.shields.io/npm/v/cuttlely)](https://www.npmjs.com/package/cuttlely)
[![CI](https://github.com/cuttlely/cuttlely/actions/workflows/main.yml/badge.svg?branch=main)](https://github.com/cuttlely/cuttlely/actions/workflows/main.yml)

**あなたのアプリケーションに、エージェントを。**

Cuttlely は、AI エージェントを構築し、オーケストレーションするためのオープンソースのビジュアルグラフエディターです。エージェントとツールをキャンバスにドラッグしてチームとしてつなげば、数分でチャットでき、そのまま API を通じてアプリから呼び出せます。動作するのは、あなたが管理するインフラの上です。

**1.3.1 を公開しました。** 公開済みのチャットフローやエージェントフローはどれも MCP サーバーにでき、公開済みのチャットフローが IBM watsonx Orchestrate のエージェントに応答します。[変更履歴](./CHANGELOG.md#131---2026-10-21)

## 目次

-   [チームが苦情を解決するところを見る](#watch-a-team-resolve-a-complaint)
-   [公開前に、すべての変更を A/B テスト](#ab-test-every-change-before-it-goes-live)
    -   [下書き、テスト、バージョン履歴](#drafts-tests-and-version-history)
-   [実際のチームのために](#made-for-real-teams)
-   [アプリを動かすエージェントチーム](#agent-teams-that-power-your-apps)
-   [アプリからチームを使う](#use-a-team-from-your-app)
-   [すべてのフローを MCP サーバーに](#every-flow-an-mcp-server)
-   [IBM watsonx Orchestrate からフローを呼び出す](#call-a-flow-from-ibm-watsonx-orchestrate)
-   [小さなコンテキストで、大きな答え](#small-context-big-answers)
-   [チームが使うツール](#tools-your-teams-use)
-   [最初の 10 分](#your-first-10-minutes)
-   [ガイド](#guides)
-   [既存のフローを持ち込む](#bring-your-existing-flows)
-   [コントリビュート](#contributing)
-   [概要とクレジット](#about-and-credits)
-   [お問い合わせ](#contact)

## チームが苦情を解決するところを見る

<a id="watch-a-team-resolve-a-complaint"></a>

<p align="center">
<a href="https://cuttlely.com/media/customer-care-demo.mp4?v=8ec56722"><img src="./website/public/media/customer-care-demo-poster.webp" alt="Try the demo のカスタマーケアチームの実行を、ナレーション付きで見られます（78 秒、字幕あり）。タイトルカードには、ロゴの横で手を振る Cuttlely のマスコットと、Your applications deserve agents という一文が映っています。" width="880"></a>
<br>
<a href="https://cuttlely.com/media/customer-care-demo.mp4?v=8ec56722">ナレーション付きの実行を見る（78 秒、音声あり）</a>
</p>

ある顧客が、注文の遅れについて問い合わせてきます。カスタマースペシャリストがアカウントを読み、オペレーションスペシャリストが荷物が倉庫から一度も出ていないことを突き止め、オペレーションの作業が終わるとポリシースペシャリストが文書化されたポリシーを確認します。それぞれが自分のデータとツールを持っています。Harness Prime が判断、返信、アクションを、根拠とともに書きます。[Try the demo](./docs/how-to/try-the-demo.md) を使うと、このチームがあなた自身のモデルキーで開きます。

## 公開前に、すべての変更を A/B テスト

<a id="ab-test-every-change-before-it-goes-live"></a>
<a id="test-every-change-before-it-goes-live"></a>
<a id="ship-changes-safely-draft-compare-publish-roll-back"></a>

編集はすべて下書きに保存され、その間も Live はアプリへの応答を続けます。Publish ダイアログの Compare は、実際の質問を Live と下書きの両方に投げ、公開する前にそれぞれの答えに Same、Changed、Error のいずれかの印を付けます。passing test set（合格が必要なテストセット）をオンにすると、Publish は下書きが合格するまで待ちます。テストには最大 100 組の質問と回答のペアを使えます。さらに増やすことはロードマップにあります。

<p align="center">
<a href="https://cuttlely.com/media/products/testing.mp4?v=d1873063"><img src="./website/public/media/products/testing-poster.webp" alt="テスト動画のタイトルカード。Cuttlely のマスコットがクリップボードと虫眼鏡を持ち、その横に Cuttlely のロゴ、Testing という文字、Compare, score, then publish という一文があります。" width="880"></a>
<br>
<a href="https://cuttlely.com/media/products/testing.mp4?v=d1873063">テストの実行を見る（56 秒、音声あり）</a>
</p>

![Bakery helper の設定にある passing test set。Require a passing test set before Publish がオンで、データセットは Saturday hours、Pass at は 100、Mentions rye と Short answer にチェックが入っています。](./docs/images/evaluations/publish-gate-settings.png)

手順は [Compare で変更を A/B テストする](./docs/how-to/ab-testing.md) で説明しています。そのほかに何ができるかは [下書き、テスト、バージョン履歴](#drafts-tests-and-version-history) にあります。

### 下書き、テスト、バージョン履歴

<a id="drafts-tests-and-version-history"></a>

-   **下書きは Live に影響しません。** チャットフロー、エージェントフロー、ハーネス、パイプラインでは、キャンバスは下書きに保存します。API、埋め込み、共有リンク、スケジュール、Webhook、ハーネスの外部実行ルート、パイプラインのスケジュール実行は、公開するまで Live を提供し続けます。キャンバスのテストチャットは下書きを実行します。ハーネスのキャンバスチャットと Try it も同じです。パイプラインの **Preview** は下書きを実行し、ストアには書き込みません。
-   **公開する前に比較。** 最近の質問を Live と下書きの両方で実行し、それぞれの答えに Same、Changed、Error の印を付けます。
-   **実際の答えがテストになります。** [Add to test set](./docs/how-to/tests-from-answers.md) で答えを一つ追加することも、ある期間に高評価または低評価が付いた答えを、一度に最大 500 行まで新しい行として追加することもできます。
-   **下書きを採点。** テキスト、JSON、数値、モデルの各エバリュエーターが Pass、Fail、Error を判定し、Live と下書きそれぞれの合格率を出します。[評価](./docs/how-to/evaluations.md)
-   **Publish は合格を待ちます。** Passing test set のゲートは、チャットから始まるチャットフローまたはエージェントフローで使え、あなたがオンにするまではオフです。オンにすると、現在の下書きが合格するまで Publish は無効のままです。[`cuttlely check --gate`](./docs/how-to/ci-gate.md) は同じチェックを CI で実行します。
-   **すべてのバージョンが残ります。** 古いバージョンを下書きとして開くことも、Live をワンステップで前に戻すこともできます。Dev から Prod への昇格もでき、Prod のオーナーが **Promote to Live** を選んだときにだけ Live になります。
-   チャットフロー、エージェントフロー、ハーネス、パイプラインは、保存したバージョンをそれぞれ、何がだれによって変わったかとともに残します。
-   Dev と Prod は同じ GitHub リポジトリに接続します。Prod は Dev が公開したものを一覧にし、何が変わるか、どの資格情報が必要かを示し、同じ並列比較のチェックを実行できます。資格情報は各サーバーがそれぞれ持ち、受け渡されるのは名前だけです。

ゲートが対象にするのは、現在の下書きの Publish だけです。Live のロールバック、Promote from Dev、`PUT /api/v1/chatflows/:id` は、今も Live を変更します。[どれが該当するかを見る](./docs/how-to/versioning.md#require-a-passing-test-set-before-you-publish)。

チャットフロー、エージェントフロー、ハーネスでは、Publish ダイアログが最近の質問（4、10、25、50、100 件。最初は 4 が選ばれています）を Live で一度、下書きで一度実行し、両方の答えを、それぞれにかかったトークンと時間とともに並べて表示できます。**Choose questions** を使うと、代わりに保存済みの質問を手で選べます。この場合も上限は管理者が設定した件数です。**Save as dataset** はチェックを入れた質問を保存し、期待される答えは空欄のまま、Datasets で記入できます。フォーム、Webhook、スケジュールから始まるエージェントフローでは、代わりに記録された入力を同じ件数だけ再実行します。パイプラインは何が変わったかを一覧にするだけで、このチェックは実行しません。チェックが Live や下書きを変えることはなく、チャット履歴にも何も残りません。実際に投稿や書き込みを行うステップを含むフローは、それでも実行すると選ばない限りスキップされます。チャットフローまたはチャットから始まるエージェントフローでは、**Questions from** で **A dataset** を選び、エバリュエーターを選んで、passing test set をオンにします。ハーネスはその実行に限ってデータセットを採点でき、フォーム、Webhook、スケジュールから始まるものではできません。**Admin** > **Server Settings** > **Testing and Limits** で Publish のチェックをオンまたはオフにします。この切り替えは次のチェックから適用され、Publish 自体は変わりません。

![チェック後の Bakery helper の Publish ダイアログ。4 件中 1 件が異なる答え、4 件中 3 件が同じ答えです。トークンは Live 235、下書き 235。標準的な時間は Live 0.1 秒、下書き 0.1 秒。推定コストは Live、下書きともに価格なし。What time do you open on Saturday? には Changed の印があり、Live は We open at 8 AM on Saturdays、Draft は We open at 7 AM on Saturdays と答えています。Do you have gluten-free bread today? には Same の印があり、Live と Draft はどちらも No, we bake gluten-free bread only on Tuesdays と答えています。それぞれの答えに、そのトークン、0.1 秒、価格なしが表示されています。](./docs/images/versioning/publish-check-results.png)

[バージョン履歴のガイド](./docs/how-to/versioning.md) · [公開する前に最近の質問をチェックする](./docs/how-to/versioning.md#check-recent-questions-before-you-publish) · [フローを Dev から Prod へ移す](./docs/how-to/versioning.md#move-a-flow-from-dev-to-prod)

## 実際のチームのために

<a id="made-for-real-teams"></a>

ロール、チームごとの分離、サインイン、監査ログを、あなたが運用するサーバーで。

-   [ロールと権限](./docs/how-to/roles-and-permissions.md)。チーム、組み込みのロール、各ページとルートの権限キー。
-   [サインイン](./docs/how-to/sign-in.md)。最初のアカウントを作ります。チームは AuthKit なしで、ローカルユーザー（`CUTTLELY_LOCAL_USERS`）でサインインできます。AuthKit はあとからオンにでき、確認済みのメールアドレスが既存のローカルユーザーにひも付きます。
-   [AuthKit なしのユーザー](./docs/how-to/users-without-authkit.md)。ローカルユーザー、招待とリセットのリンク、組み込みの Owner、Admin、Builder、Viewer のロール、セッション。招待された人は、AuthKit の有無にかかわらず、本人あての 1 回限りの招待リンクからのみ参加できます: [ユーザーを招待する](./docs/how-to/sign-in.md#invite-people)。
-   [監査ログ](./docs/how-to/audit-log.md)。サインイン、ロックアウト、招待、リセット、ロールの変更、ユーザーの無効化、設定の変更。
-   [サーバー設定](./docs/how-to/server-settings.md)。サインイン、データベース、ストレージなどを **Admin** から変更します。実行時の設定は再起動なしで適用されます。対象は Testing and Limits、セキュリティの上限、招待とリセットの有効期限、SMTP のホスト、ポート、secure フラグ、ユーザー、`SENDER_EMAIL`、招待の送り方、設定履歴の上限、`CUTTLELY_AUDIT_RETENTION_DAYS` です。環境変数だけで設定する値（シークレット、`PORT`、データフォルダー、SMTP のパスワードなど）は、Set か Not set だけが表示されます。一覧は [起動オプション](./docs/reference/startup-options.md) にあります。

## アプリを動かすエージェントチーム

<a id="agent-teams-that-power-your-apps"></a>

アプリに、単一のプロンプトではなくチームを。エージェントチームとは、リーダー役のエージェントとスペシャリストたちの集まりです。Cuttlely では、エージェントチームを harness（ハーネス）と呼びます。リーダーの Harness Prime は質問を読み、いくつかの部分に分け、それぞれを適切なスペシャリストに送り、一つの答えを書きます。スペシャリストはそれぞれ、自分のモデル、ツール、プレイブック、データを持てます。チャットフローはチーム全体を名前で呼び出すので、アプリ、共有リンク、ウェブサイトの埋め込みからチームに届きます。アプリは API でチームに質問を送り、調べ上げた一つの答え、グラフ、またはアクションを受け取ります。[ハーネスのガイド](./docs/how-to/harnesses.md)

-   **アナリスト**（The Analyst）は、専用のデータベースを持つスペシャリストです。テーブルを作り、行を追加し、それについての質問に実際の数字で答えます。Cuttlely 自身のテーブルは決して読みません。長い結果はページに分けて返ります。1 つのハーネスに複数のアナリストを置くこともでき、それぞれが自分のデータベースを持ちます。Harness Prime は質問ごとに、合うアナリストに送ります。`CUTTLELY_ANALYST=auto` でオンにします。[アナリストのガイド](./docs/how-to/analyst.md)

![データベースについて質問したあとのキャンバスチャット（ダークテーマ）。Run カードには Harness Prime sent work to analyst とあり、analyst の行には done、OpenAI gpt-5.6-luna、3 tools と表示されています。答えはタイトルとステータスの表で、draft agenda が open、send invites が open です。](./docs/images/harnesses/canvas-chat-analyst.png)

## アプリからチームを使う

<a id="use-a-team-from-your-app"></a>

**Harness** カードを一枚置いたチャットフローの後ろにチームを置いて公開し、**API Keys** でキーを発行します。そのキーの **Harnesses this key may run** でハーネスにチェックを入れてください。新しいキーはどのハーネスも実行できず、チェックするまで呼び出しは `403` になります。アプリが質問を送ると、チームの答えが返ってきます。以下は、`baker` と `orders` という二つのスペシャリストを持つ小さなパン屋のチームへの、実際の呼び出しです。

```bash
curl -s http://localhost:43117/api/v1/prediction/<chatflow-id> \
  -H "Authorization: Bearer $CUTTLELY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"question": "How much are two croissants and a sourdough loaf, and can I pick them up on Monday?"}' \
  | jq '{text, agents: [.agents[] | {name, task}]}'
```

```json
{
    "text": "Two croissants and a sourdough loaf cost $14.00. However, you cannot pick them up on Monday because the bakery is closed; pick up is possible Tuesday to Sunday from 7:00 to 15:00.",
    "agents": [
        {
            "name": "baker",
            "task": "How much are two croissants and a sourdough loaf?"
        },
        {
            "name": "orders",
            "task": "Can I pick up two croissants and a sourdough loaf on Monday?"
        }
    ]
}
```

Harness Prime が質問を分けました。`baker` が注文の値段を出し、`orders` が受け取りの日を確認しています。完全なレスポンスには、トークン、時間、ソース、チームが作った画像も含まれます。そのほかは [API ガイド](./docs/api.md) にあります。API キー、ストリーミング、会話のメモリー、ファイルのアップロード、エラー、そしてキーを自分のサーバーに置いたままにできる、実行可能なサンプルのウェブアプリです。時間のかかるターンは、同じキーで `POST /api/v1/harnesses/<name>/runs/async` からバックグラウンドで開始し、答えを後で取得できます。ハーネスは cron のスケジュールで実行することもできます：[API キーでアプリから実行する](./docs/how-to/harnesses.md#run-it-from-your-app-with-an-api-key)、[スケジュールで実行する](./docs/how-to/harnesses.md#run-it-on-a-schedule)。リファレンス：[ハーネスの Prediction API](./docs/how-to/harnesses.md#prediction-api) と [チャットフローからハーネスを呼び出す](./docs/how-to/harnesses.md#call-the-harness-from-a-chatflow)。

## すべてのフローを MCP サーバーに

<a id="every-flow-an-mcp-server"></a>

ほかのエージェントが、あなたの Live のフローを MCP で呼び出せます。編集内容は公開するまで下書きに残ります。[10 分で始める](https://cuttlely.com/quickstart/) · [GitHub でスターを付ける](https://github.com/cuttlely/cuttlely)

-   **オンにするまでオフ。** フローの **MCP Server** をオンにすると、Streamable HTTP のエンドポイント（`/api/v1/mcp/<flow id>`）とベアラートークンが発行されます。
-   **Live（公開済み）のフローのみ。1 つのフローが 1 回のツール呼び出しです。** 呼び出しが下書きを実行することはなく、前の呼び出しを覚えていません。フローの Rate Limit が適用され、1 MB を超えるリクエスト本文は拒否されます。
-   **mcp-remote 経由の MCP クライアント。** MCP サーバーをローカルコマンドとして起動するクライアントは `npx mcp-remote $CUTTLELY_URL/api/v1/mcp/<flow id> --header "Authorization: Bearer <MCP token>"` で接続します。[mcp-remote で接続する](./docs/api.md#connect-with-mcp-remote)

[MCP エンドポイントのリファレンス](./docs/api.md#mcp-endpoint)

## IBM watsonx Orchestrate からフローを呼び出す

<a id="call-a-flow-from-ibm-watsonx-orchestrate"></a>

公開済みのチャットフローを外部エージェントとして登録すると、Orchestrate のネイティブエージェントがコラボレーターとして質問を渡します。フローには API キーのひも付けが必要で、キーのないフローは拒否されます。フローをリモート MCP ツールキットとして取り込む手順も文書化されています。[Orchestrate からチャットフローを呼び出す](./docs/how-to/orchestrate.md) · [チャットフローを Orchestrate のツールキットとして使う](./docs/how-to/orchestrate-mcp.md)

## 小さなコンテキストで、大きな答え

<a id="small-context-big-answers"></a>

長いチャット、大きなテーブル、長いルールブックがあっても、プロンプトが長くなるとは限りません。各エージェントは自分の仕事に必要なものだけを見て、どの実行も使ったトークンを示します。

-   **スペシャリストには、それぞれの仕事を。** よくあるやり方では、すべてのエージェントにチャット全体を渡します。Harness Prime は各スペシャリストに、それだけで完結するタスクを、直近のやり取りの短い要約とともに書きます。
-   **データはデータベースに置いたまま。** よくあるやり方では、クエリの結果をプロンプトに貼り付けます。アナリストが返すのは 1 ページ分の行です。「もっと見せて」と頼めば次のページが出ます。前のページは次のプロンプトに入りません。
-   **チェックしたテーブルだけ。** よくあるやり方では、データベースのスキーマ全体をプロンプトに貼り付けます。URL で接続したデータベースでは、PostgreSQL MCP ノードの **Tables and views** でテーブルやビューにチェックを入れると、アナリストのプロンプトにはそれぞれについて列名付きの 1 行だけが入ります。`describe` ツールは、アナリストが必要なときに、1 つのテーブルの列、キー、テキスト値のサンプルを返します。架空のベーカリーのデモデータベースでは、6 つのリレーションにチェックを入れると 663 トークン、スキーマ全体では 2,562 トークンです。リストの下の **Rules** ボックスには、どのビューがどの質問に答えるかなど、そのアナリスト向けの独自の指示を 2,000 文字まで書けます。Rules はモデルへの指示であり、チェックしたテーブルを広げたり書き込みを許可したりはできません。[独自のルールを書く](./docs/how-to/analyst.md#write-your-own-rules)。
-   **ルールは必要なときに読み込みます。** よくあるやり方では、すべての指示を一つの巨大なシステムプロンプトに入れます。長いルールはプレイブックに入れます。スペシャリストは、質問に必要なときにだけそれを開きます。
-   **短い引き継ぎ。** よくあるやり方では、最終的な答えを書くプロンプトに文書全体を貼り付けます。Harness Prime が読むのは、各スペシャリストの答えのうち上限を設けた一部分で、ソースの名前と短い抜粋が付きます。文書はレスポンスでアプリに返ります。
-   **すべてのトークンが見えます。** Run カードには、入力と出力のトークン、モデルが報告する場合はキャッシュされたトークン、各ステップにかかった時間が出ます。API のレスポンスにも同じ数字が入ります。Publish のチェックでは、Live と下書きを、それぞれが使ったトークンと時間とともに並べて表示します。

[Cuttlely がコンテキストを小さく保つ仕組み](./docs/how-to/context-and-tokens.md)

## チームが使うツール

<a id="tools-your-teams-use"></a>

### ナレッジパイプライン（ETL）：自分のデータからの答え

ファイル、CSV、コードリポジトリを読み込み、クリーニングして分割し、埋め込みを作って検索用に保存します。実行のたびに埋め込むのは変わった部分だけで、スケジュールで動かすこともでき、ローカルの埋め込みならプロバイダーのキーは要りません。チームとチャットフローは **ETL Retriever** で結果を検索します。[ETL のガイド](./docs/how-to/etl.md)

![実行後の Outdoor Catalog。Run カードには succeeded とあり、33 embedded、0 errors です。](./docs/images/etl/etl-run-done.png)

### チャットフロー：そのまま出せる一つのアシスタント

チャットモデル、答えるエージェントまたはチェーン、メモリー、ツールを一つのキャンバスに。チャットフローにはそれぞれ Prediction API、ウェブサイト用の埋め込み、共有できるリンクが付きます。**Harness** カードを置いたチャットフローなら、それらの後ろにチーム全体を置けます。[キャンバスのガイド](./docs/how-to/canvas.md)

![最初に保存したあとの同じチャットフロー（ダークテーマ）。ヘッダーには Draft, not live yet とあります。右側でテストチャットが開いていて、What is 18 times 24? に電卓のチップ付きで 18 times 24 is 432 と答えています。](./docs/images/canvas/build-with-ai-chat.png)

### エージェントフロー：ステップごとに進むワークフロー

ステップごとに実行され、チャットメッセージ、フォーム、Webhook、スケジュールから始められるワークフローです。カードを選ぶと、サイドパネルに設定が開きます。[キャンバスのガイド](./docs/how-to/canvas.md#workflows)

![ダークテーマの Bakery greeting ワークフロー。Start が Reply につながっています。Reply カードが選ばれていて、その Message フィールド（Welcome to the bakery! Ask me about today's bread.）が、キャンバスの右側にドッキングしたサイドパネルに表示されています。](./docs/images/canvas/canvas-workflow-panel.png)

### どこにでも組み込み済み

-   **すべてのキャンバスに Build with AI。** チーム、アシスタント、パイプライン、ワークフローを言葉で説明すると、最初のバージョンがキャンバスに置かれます。すべての部品と接続は、その前にチェックされます。組み立てに使うモデルは、あなた自身の資格情報の一つです。[チームを作る](./docs/how-to/harnesses.md#build-a-team-with-ai)、[チャットフローを作る](./docs/how-to/canvas.md#build-a-chatflow-with-ai)、[パイプラインを作る](./docs/how-to/etl.md#build-a-pipeline-with-ai)
-   **エージェントランタイムを同梱。** スペシャリストは、Cuttlely に同梱されて一緒に起動するエージェントランタイムで、同じサーバー上で動きます。追加でインストールしたりホストしたりするものはありません。[ハーネスのガイド](./docs/how-to/harnesses.md#agent-runtime-health)

## 最初の 10 分

<a id="your-first-10-minutes"></a>
<a id="chat-with-a-team-in-minutes"></a>

エージェントは初めてですか？コードを書く必要はありません。**Build with AI** でチームを説明すると、最初のバージョンがスターター質問付きでキャンバスに置かれます。テストチャットでその質問をすると、Run カードにどのスペシャリストが作業したかが出ます。うまく答えるようになったら、チームを呼び出すチャットフローから共有用のリンクとウェブサイト用の埋め込みが手に入るので、ほかの人もチャットできます。

必要なのは Docker とモデルキー一つです。手順では OpenAI を使います。**Credentials** に一覧されているチャットモデルのプロバイダーなら、どれも同じように使えます。

1. Cuttlely を入手して起動します。

    ```bash
    git clone https://github.com/cuttlely/cuttlely.git
    cd cuttlely
    docker compose up -d
    ```

    Compose は公開されている Cuttlely のイメージを取得します。取得できない場合は、代わりにチェックアウトからイメージをビルドします。初回は数分かかり、長いビルドステップでは 4 つのうち何番目かが表示されます。`docker compose ps` は Cuttlely の準備ができるまで `(health: starting)`、できると `(healthy)` と表示します。早めに [http://localhost:43117](http://localhost:43117) を開くと **Cuttlely is starting** のページが表示され、準備ができると自動で Cuttlely が開きます。

    Node.js 20 以降があれば、クローンは省けます。`npx cuttlely start` がイメージを取得して実行するので、Docker は必要です。

    ```bash
    npx cuttlely start
    ```

    これで `ghcr.io/cuttlely/cuttlely` を取得し、準備ができると [http://localhost:43117](http://localhost:43117) を開きます。`stop`、`status`、`logs`、`upgrade` は [npm でインストールする](./docs/how-to/docker.md#install-with-npm) にあります。

    Docker がない場合は、Node 24 で [ソースからビルドする](./docs/how-to/from-source.md) こともできます（`.nvmrc` は 24.15.0 に固定しています）。

2. 起動すると、サーバーが一回限りのセットアップリンクを出力します。次のコマンドで表示します。

    ```bash
    docker compose logs cuttlely | grep "Setup code"
    ```

    まだ何も出ませんか？まだ起動中です。数秒後にもう一度コマンドを実行してください。

3. リンクを開いてアカウントを作ります。パスワードは 8 文字以上で、小文字、大文字、数字、記号をそれぞれ含める必要があります。サインインした状態で **Chatflows** が開きます。
4. デモを試します。**Chatflows** に **Try the demo** カードが表示されています。**Add a model key** を選び、**OpenAI API** を選んで名前を付け、キーを貼り付けて **Add** を選びます。キーは暗号化して保存されます。次に **Try the demo** を選ぶと、用意されたカスタマーケアチームがチャットを開いた状態で開きます。最初のスターター質問（エスプレッソマシンの配送遅れについての苦情）を選びます。Run カードには、Harness Prime がカスタマーとオペレーションのスペシャリストに作業を送り、続いてポリシースペシャリストに送る様子が表示され、答えには判断、顧客への返信、アクション、根拠が書かれています。データはすべて架空のものです。各ステップと、同じカードにあるパン屋のクイックスタートは [Try the demo](./docs/how-to/try-the-demo.md) で説明しています。

    ![最初のスターター質問のあとのカスタマーケアチームのチャット。Run カードには、Harness Prime が customer、operations、policy の順に作業を送り、どれも done になったことが表示されています。判断では、遅れは Larkfield Home の責任とされ、送料の返金、2026-10-08 に届く Express での再発送、リコール、ストアクレジット、Customer Care Lead からの電話が示されています。](./docs/images/try-the-demo/customer-care-run.png)

5. 自分のチームを作ります。**Harness · Agent Team** を開き、**New agent team** を選び、続いて **Build with AI**（きらめきのボタン）を選びます。**Chat model that builds** には、あなたのモデルとキーがすでに選ばれています。例を一つ選んで **Build** を選び、チャットを開いてスターター質問を選びます。
6. 次回からは、[http://localhost:43117/signin](http://localhost:43117/signin) で **Sign in** からサインインします。

次は、[チームの後ろにパイプラインを置く](./docs/how-to/etl.md)、[スペシャリストに専用のテーブルを持たせる](./docs/how-to/analyst.md)、[チャットフローを公開する](./docs/how-to/canvas.md#build-a-chatflow-with-ai) に進みましょう。Docker の設定、ボリューム、アップグレードは [Docker](./docs/how-to/docker.md) にあります。コードを変更するには [ソースからビルドして開発サーバーを動かす](./docs/how-to/from-source.md) を参照してください。

## ガイド

<a id="guides"></a>

-   [Docker](./docs/how-to/docker.md)。SQLite を使い、一つのコンテナで Cuttlely をインストールして動かします。`npx cuttlely` も同じイメージを起動します。
-   [ソースからビルドして開発サーバーを動かす](./docs/how-to/from-source.md)。Cuttlely を自分でビルドして動かし、ライブリロードでコードを変更します。
-   [ハーネス](./docs/how-to/harnesses.md)。エージェントチームを作り、試し、チャットフローから呼び出します。
-   [コンテキストとトークン](./docs/how-to/context-and-tokens.md)。チームが各プロンプトを目の前の仕事だけに絞る仕組みと、実行が使ったトークンを確認できる場所。
-   [アナリストモード](./docs/how-to/analyst.md)。スペシャリストに専用のデータベースを持たせます。
-   [ETL](./docs/how-to/etl.md)。自分のデータを読み込み、埋め込み、検索します。
-   [キャンバスのカード](./docs/how-to/canvas.md)。チャットフロー、エージェントフロー、Build with AI。
-   [バージョン履歴](./docs/how-to/versioning.md)。下書き、Publish のチェック、復元、Dev から Prod へ。
-   [評価](./docs/how-to/evaluations.md)。テストセットを作り、答えを採点し、合格するまで Publish を待たせます。
-   [実際の答えをテストにする](./docs/how-to/tests-from-answers.md)。評価の付いた答えを一つ、またはある期間の答えをまとめて、テストセットの行として保存します。
-   [答えが変わったらビルドを失敗させる](./docs/how-to/ci-gate.md)。`cuttlely check` でパイプラインから Publish のチェックを実行します。
-   [チャットを共有・埋め込みする](./docs/how-to/share-and-embed.md)。公開リンクやウェブサイト上のチャットを、あなたの Cuttlely サーバーから提供します。
-   [自分のウェブアプリで API を使う](./docs/api.md)。自分のサイトやアプリからフローを呼び出します。実行可能なサンプル付きです。
-   [Render](./docs/how-to/render.md)。Postgres を使ったホスト型のインストール。

ソースからの実行や API リファレンスを含む完全なドキュメントは [docs/README.md](./docs/README.md) にあります。

## 既存のフローを持ち込む

<a id="bring-your-existing-flows"></a>

ほかのツールで作ったフローがありますか？**Chatflows** の **Import** メニューには **Import Flowise JSON** があり、Flowise のチャットフローまたはエージェントフローのエクスポートをチェックして適切なキャンバスで開く、短いウィザードが開きます。**Import Langflow JSON** はシンプルな Langflow のチャットを読み込みます。何が引き継がれ、何がまだサポートされていないかは [既存のフローを持ち込む](./docs/bring-your-flows.md) にあります。

## コントリビュート

<a id="contributing"></a>

[CONTRIBUTING.md](./CONTRIBUTING.md) と [ソースからビルドして開発サーバーを動かす](./docs/how-to/from-source.md) を参照してください。プルリクエストの前に、Node 24 で `pnpm verify` を実行してください。セキュリティの報告は [SECURITY.md](./SECURITY.md) へ。モジュールの境界マップは [ARCHITECTURE.md](./ARCHITECTURE.md) にあります。

## 概要とクレジット

<a id="about-and-credits"></a>

Cuttlely は Apache 2.0 のオープンソースです。各リリースでの変更は [変更履歴](./CHANGELOG.md) に、どのバージョンに修正が提供されるかは [リリースとサポート](./docs/releases.md) にあります。1.3.1 には 1.3.0 までのバージョン向けのセキュリティ修正が 2 件含まれます：[GHSA-2v98-33pc-jj6f](https://github.com/cuttlely/cuttlely/security/advisories/GHSA-2v98-33pc-jj6f) と [GHSA-4p9j-8j59-gwr7](https://github.com/cuttlely/cuttlely/security/advisories/GHSA-4p9j-8j59-gwr7)。ライセンス本文は [LICENSE.md](./LICENSE.md)、帰属表示は [NOTICE](./NOTICE) にあります。

Cuttlely は、Flowise、Nous Research の Hermes、React Flow をはじめとするオープンソースの成果の上に作られています。各プロジェクトのライセンスとリンクは [CREDITS.md](./CREDITS.md) にあります。

## お問い合わせ

<a id="contact"></a>

質問、パートナーシップ、取材のご依頼は [info@cuttlely.com](mailto:info@cuttlely.com) へ。バグや機能のアイデアは [issues](https://github.com/cuttlely/cuttlely/issues) へ、脆弱性は [SECURITY.md](./SECURITY.md) の手順でお知らせください。
