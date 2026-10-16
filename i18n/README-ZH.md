<p align="center">
<picture>
<source media="(prefers-color-scheme: dark)" srcset="../assets/brand/readme/cuttlely-readme-header-dark.png">
<img src="../assets/brand/readme/cuttlely-readme-header-light.png" alt="Cuttlely. Your applications deserve agents. The open-source agent platform for applications." width="880">
</picture>
</p>

# Cuttlely

**你的应用值得拥有智能体。**

Cuttlely 是一款开源的可视化图形编辑器，用来构建和编排 AI 智能体。把智能体和工具拖到画布上，连成一个团队，几分钟就能和它对话，然后通过 API 在你的应用里调用它。一切都运行在你掌控的基础设施上。

智能体团队由一个领头的智能体和若干专员组成。领头的 Harness Prime 把每个问题拆成几部分，专员各自用自己的模型、工具和数据完成工作，分析员则查询真实的数据表，交回实实在在的数字。你的应用通过 API 把问题发给团队，拿回一个经过研究的回答、一张图表或一个操作。在 Cuttlely 里，智能体团队叫作 harness。知识流水线、可视化工作流和 Build with AI 为团队备齐所需的一切，而每一处改动都会先作为草稿等着，直到你发布（Publish）。Cuttlely 是开源的，可以跑在你的笔记本、你自己的服务器或 Render 上。

> 功能列表（包括[在你的应用里使用团队](../README.md#use-a-team-from-your-app)的 API 示例）、发布流程（Drafts, tests, and version history）和快速上手（Your first 10 minutes）目前只有[英文 README](../README.md)。

第一次安装用 **SQLite**。不要设置 `DATABASE_TYPE`。你不用在自己的电脑上装 Postgres。Docker 一直用 SQLite。从源码运行时，Postgres 是可选的；放到公网上时，Render Blueprint 会帮你设好。每条路径的步骤都在[使用指南](#使用指南)。

chief-of-staff 里的分析员先保持关闭，直到你把 `CUTTLELY_ANALYST` 设成 `auto`。这样每个工作区都会有一块单独的存储：SQLite 文件旁边的 `analyst-<tag>.db`，或者 Postgres 上该工作区自己的 schema 和登录账号（`<tag>` 由工作区 ID 生成）。一个工作区建的表，其他工作区的分析员看不到。它不会去读应用自己的表。凭据里的 Postgres URL，或者指向另一个库的 `CUTTLELY_POSTGRES_URL`，仍然优先。步骤在[分析模式](#分析模式)。

流程的每个版本都会保留，改动只有在你决定时才会到达使用它的人。对话流和 agentflow 的画布默认保存为**草稿**，而 API、嵌入和分享链接继续运行 **Live** 版本。在你 **Publish** 对话流或 agentflow 之前，Cuttlely 可以把几个最近的真实问题在 Live 和你的草稿上各问一遍，并排显示回答。**Version history** 显示改了什么、谁改的，一键即可恢复旧版本或把 Live 回滚。所有者还可以在自己的 GitHub 仓库里保留一份副本：在浏览器中创建第一个账号后会提示一次，之后随时可在 **Admin**、**Version History** 中设置；还可以用它把流程从 Dev 服务器移到 Prod 服务器，每台服务器各自保管自己的凭据。历史保存在你的服务器上，是数据旁边的一个 Git 仓库。凭据只按名称记录，提示词里看起来像密钥的文字不会写进历史。步骤见[版本历史](#版本历史)。

[English](../README.md) | [繁體中文](./README-TW.md) | 简体中文 | [日本語](./README-JA.md) | [한국어](./README-KR.md)

英文 README 是原文。内容不一致时，以英文版为准。

## 目录

-   [A/B 测试每一项改动，再让它上线](#ab-测试每一项改动再让它上线)
-   [快速开始](#快速开始)
-   [使用指南](#使用指南)
-   [登录](#登录)
-   [试一试](#试一试)
-   [带上已有的流程](#带上已有的流程)
-   [参与贡献](#参与贡献)
-   [关于与致谢](#关于与致谢)

## A/B 测试每一项改动，再让它上线

每次编辑都先保存为草稿，Live 版本继续服务你的应用。发布（Publish）对话框里的 Compare 会把真实问题在 Live 和草稿上各问一遍，把每个回答标为 Same、Changed 或 Error，让你在发布前就看到差异。打开“通过测试集”（passing test set）之后，草稿要先通过测试集才能发布。目前最多可用 100 组问答来测试，更多容量已列入规划。

[观看测试演示（56 秒，有声音，英文）](https://cuttlely.com/media/products/testing.mp4) · [用 Compare 做 A/B 测试（英文指南）](../docs/how-to/ab-testing.md)

## 快速开始

多数人用 Docker 就好。在这份仓库的克隆里：

```bash
docker compose up -d
docker compose exec cuttlely curl -fsS http://127.0.0.1:43117/api/v1/ping
```

看到 `pong` 之后，打开 [http://localhost:43117](http://localhost:43117)。Compose 会拉取已发布的 Cuttlely 镜像；拉取不到时，会用你的克隆现场构建，第一次要几分钟。`docker compose down` 会留下你的数据。

这个容器里的数据库是 SQLite。数据卷、环境变量和 Compose 的说明在 [Docker](../docs/how-to/docker.md)。

如果你在改代码，从源码跑：[从源码运行](../docs/how-to/from-source.md)。

## 使用指南

这些是安装和使用 Cuttlely 的指南。如果你不是在改代码，就从 Docker 开始。

### 安装与部署

-   [Docker](../docs/how-to/docker.md)。Compose 会构建这个仓库。应用数据库是 SQLite，Compose 不会启动 Postgres。
-   [从源码运行](../docs/how-to/from-source.md)。改 Cuttlely 的时候用这条。自己跑一份的话，用 Docker。
-   [Render](../docs/how-to/render.md)。想把 Cuttlely 放到 Render 上时用这条。笔记本上的安装仍然用 SQLite。这份 Blueprint 会设置 Postgres。

### 登录方式

-   [登录](../docs/how-to/sign-in.md)。新安装里还没有用户。先建一个本地账号，再打开应用。WorkOS 是给团队用的，等本地账号能用之后再接。
-   [设置 WorkOS AuthKit](../docs/identity/workos-authkit-setup.md)。按步骤把一份 Cuttlely 安装接到 WorkOS AuthKit。

### Harness 与流水线

-   [Harness](../docs/how-to/harnesses.md)。一个 harness 就是 Harness Prime，再加上一个或多个专员。对话流按名字调用这个团队。
-   [ETL](../docs/how-to/etl.md)。侧边栏里的 ETL 是对话流旁边的一条流水线：加载器、一次变换，和一个存储。

### 版本历史

-   [版本历史](../docs/how-to/versioning.md)。先看[生命周期一览](../docs/how-to/versioning.md#the-lifecycle-at-a-glance)。对话流、agentflow、harness 和流水线的每个版本都会保留。对话流和 agentflow 默认开启草稿，两者都可以[在 Publish 前检查最近的问题](../docs/how-to/versioning.md#check-recent-questions-before-you-publish)。查看改了什么、和现在比较、谁改的，一键[恢复或回滚](../docs/how-to/versioning.md#restore-a-version)。所有者还可以[在 GitHub 保留一份副本](../docs/how-to/versioning.md#keep-a-copy-in-github)；也可以[把流程从 Dev 移到 Prod](../docs/how-to/versioning.md#move-a-flow-from-dev-to-prod)。
-   [历史设置](../docs/reference/versioning-settings.md)。`CUTTLELY_VERSIONS=off` 关闭历史。也说明历史仓库放在哪里。
-   [历史 API](../docs/reference/versioning-api.md)。版本历史、GitHub 副本和 Dev 到 Prod 背后的路由。
-   [草稿 API](../docs/reference/drafts-api.md)。草稿、Publish、回滚 Live 和 Publish 前检查的路由。草稿默认开启，`CUTTLELY_DRAFTS=off` 关闭草稿。
-   [版本文件](../docs/reference/version-files.md)。历史仓库里的文件和提交。

### 分析模式

-   [分析模式](../docs/how-to/analyst.md)。专员可以在自己的表里建表和查询，不会去读应用的表。
-   [Docker](../docs/how-to/docker.md)。把 `CUTTLELY_ANALYST` 设成 `auto`，就会为每个工作区在 SQLite 文件旁边创建 `analyst-<tag>.db`。
-   [从源码运行](../docs/how-to/from-source.md)。`CUTTLELY_ANALYST=auto` 会为每个工作区在 SQLite 旁边创建 `analyst-<tag>.db`；如果是 Postgres，则为每个工作区创建 analyst schema 和它自己的登录账号。它不会读取应用的表。
-   [分析数据库](../docs/how-to/render.md#analyst-database)。在 Render 上，分析模式保持关闭，直到你在 Dashboard 里把 `CUTTLELY_ANALYST` 设成 `auto`。

### Agentflow

-   Agentflows 页面上的 **Add New** 打开当前的 agentflow 画布。旧版 V1 agentflow 在应用里隐藏：Add New、Duplicate 和模板都不再新建它们。已有的旧版 agentflow 仍然可以通过 API、嵌入和分享链接运行，也能从直接链接打开；工作区里有旧版 agentflow 时，它们显示在 **Legacy agentflows** 下。

## 登录

新安装没有任何用户。打开 `docker compose logs cuttlely` 打印的设置链接，创建一个本地的所有者账号。也可以在终端里创建。

```bash
docker compose exec -u node -it -e CUTTLELY_LOCAL_ADMIN=true cuttlely pnpm user --email you@example.com
```

打开 [http://localhost:43117/signin](http://localhost:43117/signin)。密码按钮的文字是 **Sign in**。

WorkOS、团队，以及从源码创建账号，写在[登录](../docs/how-to/sign-in.md)。

## 试一试

打开 **Templates**，启动一个 harness，然后选 **Try it**。如果 Harness Prime 向你要模型密钥，先在 **Credentials** 里存一把，再在那个节点上选中它。

harness 是什么、对话流怎么调用它：[Harness](../docs/how-to/harnesses.md)。知识流水线：[ETL](../docs/how-to/etl.md)。

## 带上已有的流程

在 Chatflows 的 **Import** 菜单里，**Import Flowise JSON** 会打开一个短向导，然后进入画布。**Import Langflow JSON** 会载入一个简单对话。

能带来什么、还不支持什么：[Bring your existing flows](../docs/bring-your-flows.md)（英文）。

[Flowise 向导](../docs/flowise-migration-wizard.md) · [Langflow 导入](../docs/langflow-import.md)

## 参与贡献

见 [CONTRIBUTING.md](../CONTRIBUTING.md)。在 Node 24 上，提交拉取请求之前先跑 `pnpm verify`。安全报告请看 [SECURITY.md](../SECURITY.md)。

## 关于与致谢

Cuttlely 使用 Apache 2.0。正文在 [LICENSE.md](../LICENSE.md)。署名在 [NOTICE](../NOTICE)。

Cuttlely 建立在开源成果之上，包括 Flowise、Nous Research 的 Hermes 和 React Flow。各项目的许可证和链接见 [CREDITS.md](../CREDITS.md)。
