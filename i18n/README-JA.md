<p align="center">
<picture>
<source media="(prefers-color-scheme: dark)" srcset="../assets/brand/readme/cuttlely-readme-header-dark.png">
<img src="../assets/brand/readme/cuttlely-readme-header-light.png" alt="Cuttlely. Your applications deserve agents. The open-source agent platform for applications." width="880">
</picture>
</p>

# Cuttlely

**あなたのアプリケーションに、エージェントを。**

アプリケーションのためのオープンソースのエージェントプラットフォーム。 数分でチームとチャットを始め、そのままアプリから呼び出せます。動かすのは、自分で管理するインフラの上です。

エージェントチームは、リーダー役のエージェントとスペシャリストたちの集まりです。リーダーの Harness Prime が質問をいくつかの部分に分け、スペシャリストがそれぞれ自分のモデル、ツール、データで作業します。アナリストは実際のテーブルに問い合わせ、本当の数字を返します。アプリは API でチームに質問を送り、調べ上げた一つの答え、グラフ、またはアクションを受け取ります。Cuttlely では、エージェントチームを harness と呼びます。知識のパイプライン、ビジュアルなワークフロー、Build with AI がチームに必要なものをそろえ、変更はすべて、あなたが公開（Publish）するまで下書きのまま待ちます。Cuttlely はオープンソースで、ノート PC、自分のサーバー、Render で動きます。

> 機能の一覧（[アプリからチームを使う](../README.md#use-a-team-from-your-app) API の例を含む）、リリースの流れ（Drafts, tests, and version history）、「最初の 10 分（Your first 10 minutes）」は、今のところ[英語の README](../README.md) にだけあります。

最初のインストールは **SQLite** です。`DATABASE_TYPE` は空のままにしてください。ノート PC に Postgres を用意する必要はありません。Docker は SQLite のままです。ソースから動かすときは Postgres を選べます。公開用のホストでは Render の Blueprint が Postgres を設定します。それぞれの手順は[使い方ガイド](#使い方ガイド)にあります。

chief-of-staff のアナリストは、`CUTTLELY_ANALYST=auto` にするまでオフです。オンにすると、ワークスペースごとに、アプリとは別の置き場ができます。SQLite ファイルの隣の `analyst-<tag>.db`、Postgres ではワークスペースごとのスキーマと専用のログインです（`<tag>` はワークスペース ID から作られます）。あるワークスペースで作ったテーブルは、ほかのワークスペースのアナリストからは見えません。アプリのテーブルは読みません。資格情報の Postgres URL か、別データベース向けの `CUTTLELY_POSTGRES_URL` があれば、そちらが優先されます。手順は[アナリストモード](#アナリストモード)です。

フローのバージョンはすべて残り、変更が使う人に届くのは、あなたが決めたときだけです。チャットフローとエージェントフローのキャンバスは、既定で**下書き**に保存されます。API、埋め込み、共有リンクは **Live** のまま動き続けます。チャットフローやエージェントフローを **Publish** する前に、Cuttlely は最近の実際の質問をいくつか Live と下書きの両方にもう一度聞き、答えを並べて見せられます。**Version history** には、何がだれによって変わったかが出ます。古いバージョンの復元も、Live を前に戻すのもワンクリックです。オーナーは自分の GitHub リポジトリにコピーを置くこともできます。ブラウザで最初のアカウントを作った直後に一度だけ案内され、いつでも **Admin**、**Version History** から設定できます。このコピーで、フローを Dev サーバーから Prod サーバーへ移せます。資格情報はサーバーごとに持ちます。履歴はあなたのサーバーの、データの隣にある Git リポジトリに残ります。資格情報は名前だけを記録し、プロンプトの中の秘密らしい文字列は履歴に残しません。手順は[バージョン履歴](#バージョン履歴)です。

[English](../README.md) | [繁體中文](./README-TW.md) | [简体中文](./README-ZH.md) | 日本語 | [한국어](./README-KR.md)

英語版の README が原文です。内容が違うときは英語版に従ってください。

## 目次

-   [すぐに始める](#すぐに始める)
-   [使い方ガイド](#使い方ガイド)
-   [サインイン](#サインイン)
-   [試してみる](#試してみる)
-   [手元のフローを持ってくる](#手元のフローを持ってくる)
-   [開発に参加する](#開発に参加する)
-   [概要とクレジット](#概要とクレジット)

## すぐに始める

ほとんどの人は Docker で十分です。このリポジトリをクローンした場所で:

```bash
docker compose up -d
docker compose exec cuttlely curl -fsS http://127.0.0.1:43117/api/v1/ping
```

`pong` と出たら [http://localhost:43117](http://localhost:43117) を開きます。Compose は公開済みの Cuttlely イメージを取得します。取得できないときはクローンからビルドするので、初回は数分かかります。`docker compose down` はデータを残します。

そのコンテナのデータベースは SQLite です。ボリューム、環境変数、Compose のメモは [Docker](../docs/how-to/docker.md) にあります。

コードを変えるなら、ソースから: [ソースから](../docs/how-to/from-source.md)。

## 使い方ガイド

Cuttlely のインストールと使い方のガイドです。コードを変えないなら、Docker から始めてください。

### インストールと公開

-   [Docker](../docs/how-to/docker.md)。Compose がこのリポジトリをビルドします。アプリのデータベースは SQLite で、Compose は Postgres を起動しません。
-   [ソースから](../docs/how-to/from-source.md)。Cuttlely を変更するときに使います。自分用に動かすだけなら Docker です。
-   [Render](../docs/how-to/render.md)。Cuttlely を Render に置くときに使います。ノート PC のインストールは SQLite のままです。この Blueprint は Postgres を設定します。

### サインインのしかた

-   [サインイン](../docs/how-to/sign-in.md)。新しいインストールにはユーザーがいません。ローカルのアカウントを一つ作ってからアプリを開きます。WorkOS はチーム向けで、それが動いてから使います。
-   [WorkOS AuthKit を設定する](../docs/identity/workos-authkit-setup.md)。Cuttlely のインストールを WorkOS AuthKit につなぐ手順です。

### ハーネスとパイプライン

-   [ハーネス](../docs/how-to/harnesses.md)。ハーネスは Harness Prime と、一人以上のスペシャリストです。チャットフローはそのチームを名前で呼びます。
-   [ETL](../docs/how-to/etl.md)。サイドバーの ETL は、チャットフローの隣にあるパイプラインです。ローダー、変換、ストアでできています。

### バージョン履歴

-   [バージョン履歴](../docs/how-to/versioning.md)。まず[ライフサイクルの全体像](../docs/how-to/versioning.md#the-lifecycle-at-a-glance)を見てください。チャットフロー、エージェントフロー、ハーネス、パイプラインのバージョンはすべて残ります。チャットフローとエージェントフローは既定で下書きがオンで、どちらも[Publish の前に最近の質問を確かめる](../docs/how-to/versioning.md#check-recent-questions-before-you-publish)ことができます。何が変わったか、今との違い、だれが変えたかを見て、ワンクリックで[復元や巻き戻し](../docs/how-to/versioning.md#restore-a-version)ができます。オーナーは[GitHub にコピーを置く](../docs/how-to/versioning.md#keep-a-copy-in-github)こともできます。[フローを Dev から Prod へ移す](../docs/how-to/versioning.md#move-a-flow-from-dev-to-prod)こともできます。
-   [履歴の設定](../docs/reference/versioning-settings.md)。`CUTTLELY_VERSIONS=off` で履歴をオフにします。履歴リポジトリの置き場所も説明します。
-   [履歴 API](../docs/reference/versioning-api.md)。バージョン履歴、GitHub のコピー、Dev から Prod への移動を支えるルートです。
-   [下書き API](../docs/reference/drafts-api.md)。下書き、Publish、Live の巻き戻し、Publish 前のチェックのルートです。下書きは既定でオンで、`CUTTLELY_DRAFTS=off` でオフになります。
-   [バージョンファイル](../docs/reference/version-files.md)。履歴リポジトリのファイルとコミットです。

### アナリストモード

-   [アナリストモード](../docs/how-to/analyst.md)。スペシャリストが自分のテーブルを作り、問い合わせます。アプリのテーブルは読みません。
-   [Docker](../docs/how-to/docker.md)。`CUTTLELY_ANALYST` を `auto` にすると、ワークスペースごとに、SQLite ファイルの隣に `analyst-<tag>.db` ができます。
-   [ソースから](../docs/how-to/from-source.md)。`CUTTLELY_ANALYST=auto` は、ワークスペースごとに、SQLite の隣に `analyst-<tag>.db` を作るか、Postgres ではアナリスト用スキーマと専用ログインを作ります。アプリのテーブルは読みません。
-   [アナリストのデータベース](../docs/how-to/render.md#analyst-database)。Render では、Dashboard で `CUTTLELY_ANALYST` を `auto` にするまでアナリストモードはオフです。

### エージェントフロー

-   Agentflows の **Add New** は、今のエージェントフローのキャンバスを開きます。旧版の V1 エージェントフローはアプリから隠れています。Add New、Duplicate、テンプレートでは新しく作られません。既存の旧版エージェントフローは、API、埋め込み、共有リンクで今も動き、直接のリンクからも開けます。ワークスペースにあれば **Legacy agentflows** の下に表示されます。

## サインイン

新しいインストールにはユーザーがいません。`docker compose logs cuttlely` に出るセットアップ用リンクを開いて、オーナーのローカルアカウントを一つ作ります。ターミナルで作ることもできます。

```bash
docker compose exec -u node -it -e CUTTLELY_LOCAL_ADMIN=true cuttlely pnpm user --email you@example.com
```

[http://localhost:43117/signin](http://localhost:43117/signin) を開きます。パスワードのボタンは **Sign in** です。

WorkOS、チーム、ソースからのアカウントは [サインイン](../docs/how-to/sign-in.md) にあります。

## 試してみる

**Templates** を開き、ハーネスを始めて、**Try it** を選びます。Harness Prime がモデルのキーを求めたら、**Credentials** に保存して、そのノードで選んでください。

ハーネスとは何か、チャットフローがどう呼ぶか: [ハーネス](../docs/how-to/harnesses.md)。知識のパイプライン: [ETL](../docs/how-to/etl.md)。

## 手元のフローを持ってくる

Chatflows の **Import** メニューで **Import Flowise JSON** を選ぶと、短いウィザードが開いてからキャンバスになります。**Import Langflow JSON** はシンプルなチャットを読み込みます。

何が持ち込めて、何がまだ使えないか: [Bring your existing flows](../docs/bring-your-flows.md)（英語）。

[Flowise ウィザード](../docs/flowise-migration-wizard.md) · [Langflow の取り込み](../docs/langflow-import.md)

## 開発に参加する

[CONTRIBUTING.md](../CONTRIBUTING.md) を見てください。Node 24 では、プルリクエストの前に `pnpm verify` を実行します。セキュリティの報告は [SECURITY.md](../SECURITY.md) へ。

## 概要とクレジット

Cuttlely は Apache 2.0 です。本文は [LICENSE.md](../LICENSE.md) にあります。帰属は [NOTICE](../NOTICE) です。

Cuttlely は Flowise、Nous Research の Hermes、React Flow などのオープンソースの成果の上に作られています。各プロジェクトのライセンスとリンクは [CREDITS.md](../CREDITS.md) にあります。
