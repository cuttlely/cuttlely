<p align="center">
<picture>
<source media="(prefers-color-scheme: dark)" srcset="../assets/brand/readme/cuttlely-readme-header-dark.png">
<img src="../assets/brand/readme/cuttlely-readme-header-light.png" alt="Cuttlely。上下文感知型智慧體編排。開源，Apache-2.0。" width="880">
</picture>
</p>

# Cuttlely

上下文感知型智慧體編排。開源，Apache-2.0。

Cuttlely 讓你以視覺化方式建構 AI 智慧體團隊，每位智慧體只取得所需的上下文，因此你可以在發布前看清每次執行的使用量與成本。在任何變更生效前，先把真實問題在 Live 和草稿上並排再執行一次。

```bash
npx cuttlely start
```

Node 20+ 和 Docker

[10 分鐘上手](https://cuttlely.com/quickstart/) · [在 GitHub 上加星](https://github.com/cuttlely/cuttlely) · [已有流程？把它們帶過來](https://cuttlely.com/flowise/)

最新穩定版是 **1.7.2**。請鎖定映像檔 `1.7.2`，或安裝 `cuttlely@1.7.2`。[1.7.2 發行說明](https://github.com/cuttlely/cuttlely/releases/tag/v1.7.2) · [變更記錄](../CHANGELOG.md)。

**1.7.0 是安全例外版本。若你是從更早的版本升級，必須採取行動。** 請先備份資料庫、加密金鑰和設定，並在部署前閱讀[操作員的指定與復原](../docs/how-to/instance-operator.md)，以免被鎖在瀏覽器管理之外。完整檢查清單（包括以主機日誌一次性代碼提出的申請、`CUTTLELY_INSTANCE_OPERATOR`，以及存取金鑰強制執行預設維持關閉）見[升級注意事項](../docs/upgrading.md)（「1.7.0 security-exception upgrade」節）和[變更記錄](../CHANGELOG.md)。初始設定代碼只會建立第一個帳號，而且只有在主機已開啟本機登入時才有效（Docker 和 `npx cuttlely start` 預設會開啟）。它不能用來設定服務，也不會指定執行個體操作員。[登入](../docs/how-to/sign-in.md) · [快速上手（Your first 10 minutes）](../README.md#your-first-10-minutes)。

> 功能列表（包括[在你的應用裡使用團隊](../README.md#use-a-team-from-your-app)的 API 範例）、發布流程（Drafts, tests, and version history）和快速上手（Your first 10 minutes）目前只有[英文 README](../README.md)。

[English](../README.md) | [日本語](../README.ja.md) | [한국어](../README.ko.md) | 繁體中文 | [简体中文](./README-ZH.md)

英文 README 是原文。內容不一致時，以英文版為準。

## 目錄

-   [A/B 測試每一項變更，再讓它上線](#ab-test-every-change-before-it-goes-live)
-   [快速開始](#quick-start)
-   [登入](#sign-in)
-   [試一試](#try-it)
-   [使用指南](#guides)
-   [帶上已有的流程](#bring-your-existing-flows)
-   [參與貢獻](#contributing)
-   [關於與致謝](#about-and-credits)

## A/B 測試每一項變更，再讓它上線

<a id="ab-test-every-change-before-it-goes-live"></a>

每次編輯都先存成草稿，Live 版本繼續服務你的應用。發布（Publish）對話框裡的 Compare 會把真實問題在 Live 和草稿上各問一次，把每個回答標成 Same、Changed 或 Error，讓你在發布前就看到差異。打開「通過測試集」（passing test set）之後，草稿要先通過測試集才能發布。目前最多可用 100 組問答來測試，更多容量已列入規劃。

[觀看測試示範（56 秒，有聲音，英文）](https://cuttlely.com/media/products/testing.mp4?v=d1873063) · [用 Compare 做 A/B 測試（英文指南）](../docs/how-to/ab-testing.md)

## 快速開始

<a id="quick-start"></a>

多數人用 Docker 就好。在這份儲存庫的複本裡：

```bash
docker compose up -d
docker compose exec cuttlely curl -fsS http://127.0.0.1:43117/api/v1/ping
```

看到 `pong` 之後，開啟 [http://localhost:43117](http://localhost:43117)。Compose 會拉取已發布的 Cuttlely 映像檔；拉取不到時，會用你的複本現場建置，第一次要幾分鐘。`docker compose down` 會留下你的資料。

這個容器裡的資料庫是 SQLite。資料卷、環境變數和 Compose 的說明在 [Docker](../docs/how-to/docker.md)。

如果你在改程式，從原始碼跑：[從原始碼執行](../docs/how-to/from-source.md)。

## 登入

<a id="sign-in"></a>

新安裝沒有任何使用者。開啟 `docker compose logs cuttlely | grep "Setup code"` 印出的設定連結，建立一個本機的擁有者帳號。也可以在終端機裡建立。

```bash
docker compose exec -u node -it -e CUTTLELY_LOCAL_ADMIN=true cuttlely pnpm user --email you@example.com
```

開啟 [http://localhost:43117/signin](http://localhost:43117/signin)。密碼按鈕的文字是 **Sign in**。

WorkOS、團隊，以及從原始碼建立帳號，寫在[登入](../docs/how-to/sign-in.md)。

## 試一試

<a id="try-it"></a>

開啟 **Templates**，啟動一個 harness，然後選 **Try it**。如果 Harness Prime 向你要模型金鑰，先在 **Credentials** 裡存一把，再在那個節點上選取它。

harness 是什麼、對話流怎麼呼叫它：[Harness](../docs/how-to/harnesses.md)。知識管線：[ETL](../docs/how-to/etl.md)。

## 使用指南

<a id="guides"></a>

這些是安裝和使用 Cuttlely 的指南。如果你不是在改程式，就從 Docker 開始。

### 安裝與部署

-   [Docker](../docs/how-to/docker.md)。Compose 會建置這個儲存庫。應用資料庫是 SQLite，Compose 不會啟動 Postgres。
-   [從原始碼執行](../docs/how-to/from-source.md)。改 Cuttlely 的時候用這條。自己跑一份的話，用 Docker。
-   [Render](../docs/how-to/render.md)。想把 Cuttlely 放到 Render 上時用這條。筆記型電腦上的安裝仍然用 SQLite。這份 Blueprint 會設定 Postgres。

### 登入方式

-   [登入](../docs/how-to/sign-in.md)。新安裝裡還沒有使用者。先建一個本機帳號，再開啟應用。WorkOS 是給團隊用的，等本機帳號能用之後再接。
-   [設定 WorkOS AuthKit](../docs/identity/workos-authkit-setup.md)。按步驟把一份 Cuttlely 安裝接到 WorkOS AuthKit。

### Harness 與管線

-   [Harness](../docs/how-to/harnesses.md)。一個 harness 就是 Harness Prime，再加上一個或多個專員。對話流按名稱呼叫這個團隊。
-   [ETL](../docs/how-to/etl.md)。側邊欄裡的 ETL 是對話流旁邊的一條管線：載入器、一次轉換，和一個儲存。

### 版本歷史

<a id="version-history"></a>

-   [版本歷史](../docs/how-to/versioning.md)。先看[生命週期一覽](../docs/how-to/versioning.md#the-lifecycle-at-a-glance)。對話流、agentflow、harness 和管線的每個版本都會保留。對話流和 agentflow 預設開啟草稿，兩者都可以[在 Publish 前檢查最近的問題](../docs/how-to/versioning.md#check-recent-questions-before-you-publish)。查看改了什麼、和現在比較、誰改的，一鍵[還原或回到先前的版本](../docs/how-to/versioning.md#restore-a-version)。擁有者還可以[在 GitHub 保留一份副本](../docs/how-to/versioning.md#keep-a-copy-in-github)；也可以[把流程從 Dev 移到 Prod](../docs/how-to/versioning.md#move-a-flow-from-dev-to-prod)。
-   [歷史設定](../docs/reference/versioning-settings.md)。`CUTTLELY_VERSIONS=off` 關閉歷史。也說明歷史儲存庫放在哪裡。
-   [歷史 API](../docs/reference/versioning-api.md)。版本歷史、GitHub 副本和 Dev 到 Prod 背後的路由。
-   [草稿 API](../docs/reference/drafts-api.md)。草稿、Publish、讓 Live 回到先前版本和 Publish 前檢查的路由。草稿預設開啟，`CUTTLELY_DRAFTS=off` 關閉草稿。
-   [版本檔案](../docs/reference/version-files.md)。歷史儲存庫裡的檔案和提交。

### 分析模式

<a id="analyst-mode"></a>

-   [分析模式](../docs/how-to/analyst.md)。專員可以在自己的表裡建表和查詢，不會去讀應用的表。
-   [Docker](../docs/how-to/docker.md)。把 `CUTTLELY_ANALYST` 設成 `auto`，就會為每個工作區在 SQLite 檔案旁邊建立 `analyst-<tag>.db`。
-   [從原始碼執行](../docs/how-to/from-source.md)。`CUTTLELY_ANALYST=auto` 會為每個工作區在 SQLite 旁邊建立 `analyst-<tag>.db`；如果是 Postgres，則為每個工作區建立 analyst schema 和它自己的登入帳號。它不會讀取應用的表。
-   [分析資料庫](../docs/how-to/render.md#analyst-database)。在 Render 上，分析模式保持關閉，直到你在 Dashboard 裡把 `CUTTLELY_ANALYST` 設成 `auto`。

### Agentflow

-   Agentflows 頁面上的 **Add New** 開啟目前的 agentflow 畫布。舊版 V1 agentflow 在應用程式裡隱藏：Add New、Duplicate 和範本都不再建立它們。現有的舊版 agentflow 仍然可以透過 API、嵌入和分享連結執行，也能從直接連結開啟；工作區裡有舊版 agentflow 時，它們會顯示在 **Legacy agentflows** 下。

## 帶上已有的流程

<a id="bring-your-existing-flows"></a>

在 Chatflows 的 **Import** 選單裡，**Import Flowise JSON** 會開啟一個短精靈，然後進入畫布。**Import Langflow JSON** 會載入一個簡單對話。

能帶來什麼、還不支援什麼：[Bring your existing flows](../docs/bring-your-flows.md)（英文）。

[Flowise 精靈](../docs/flowise-migration-wizard.md) · [Langflow 匯入](../docs/langflow-import.md)

## 參與貢獻

<a id="contributing"></a>

見 [CONTRIBUTING.md](../CONTRIBUTING.md)。在 Node 24 上，送出拉取請求之前先跑 `pnpm verify`。安全報告請看 [SECURITY.md](../SECURITY.md)。

## 關於與致謝

<a id="about-and-credits"></a>

Cuttlely 使用 Apache 2.0。正文在 [LICENSE.md](../LICENSE.md)。署名在 [NOTICE](../NOTICE)。

Cuttlely 建立在開源成果之上，包括 Flowise、Nous Research 的 Hermes 與 React Flow。各專案的授權與連結見 [CREDITS.md](../CREDITS.md)。
