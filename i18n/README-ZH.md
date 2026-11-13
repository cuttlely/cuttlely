<p align="center">
<picture>
<source media="(prefers-color-scheme: dark)" srcset="../assets/brand/readme/cuttlely-readme-header-dark.png">
<img src="../assets/brand/readme/cuttlely-readme-header-light.png" alt="Cuttlely。上下文感知型智能体编排。开源，Apache-2.0。" width="880">
</picture>
</p>

# Cuttlely

上下文感知型智能体编排。开源，Apache-2.0。

Cuttlely 让你以可视化方式构建 AI 智能体团队，每个智能体只取得所需的上下文，因此你可以在发布前看清每次运行的使用量与成本。在任何变更生效前，先把真实问题在 Live 和草稿上并排再运行一次。

```bash
npx cuttlely start
```

Node 20+ 和 Docker

[10 分钟上手](https://cuttlely.com/quickstart/) · [在 GitHub 上加星](https://github.com/cuttlely/cuttlely) · [已有流程？把它们带过来](https://cuttlely.com/flowise/)

最新稳定版是 **1.7.2**。请固定镜像 `1.7.2`，或安装 `cuttlely@1.7.2`。[1.7.2 发行说明](https://github.com/cuttlely/cuttlely/releases/tag/v1.7.2) · [更新日志](../CHANGELOG.md)。

**1.7.0 是安全例外版本。若你是从更早的版本升级，必须采取行动。** 请先备份数据库、加密密钥和设置，并在部署前阅读[操作员的指定与恢复](../docs/how-to/instance-operator.md)，以免被锁在浏览器管理之外。完整检查清单（包括以主机日志一次性代码提出的申请、`CUTTLELY_INSTANCE_OPERATOR`，以及访问密钥强制执行默认保持关闭）见[升级注意事项](../docs/upgrading.md)（“1.7.0 security-exception upgrade”节）和[更新日志](../CHANGELOG.md)。初始设置代码只会创建第一个账号，而且只有在主机已开启本地登录时才有效（Docker 和 `npx cuttlely start` 默认会开启）。它不能用来配置服务，也不会指定实例操作员。[登录](../docs/how-to/sign-in.md) · [快速上手（Your first 10 minutes）](../README.md#your-first-10-minutes)。

> 功能列表（包括[在你的应用里使用团队](../README.md#use-a-team-from-your-app)的 API 示例）、发布流程（Drafts, tests, and version history）和快速上手（Your first 10 minutes）目前只有[英文 README](../README.md)。

[English](../README.md) | [日本語](../README.ja.md) | [한국어](../README.ko.md) | [繁體中文](./README-TW.md) | 简体中文

英文 README 是原文。内容不一致时，以英文版为准。

## 目录

-   [A/B 测试每一项改动，再让它上线](#ab-test-every-change-before-it-goes-live)
-   [快速开始](#quick-start)
-   [登录](#sign-in)
-   [试一试](#try-it)
-   [使用指南](#guides)
-   [带上已有的流程](#bring-your-existing-flows)
-   [参与贡献](#contributing)
-   [关于与致谢](#about-and-credits)

## A/B 测试每一项改动，再让它上线

<a id="ab-test-every-change-before-it-goes-live"></a>

每次编辑都先保存为草稿，Live 版本继续服务你的应用。发布（Publish）对话框里的 Compare 会把真实问题在 Live 和草稿上各问一遍，把每个回答标为 Same、Changed 或 Error，让你在发布前就看到差异。打开“通过测试集”（passing test set）之后，草稿要先通过测试集才能发布。目前最多可用 100 组问答来测试，更多容量已列入规划。

[观看测试演示（56 秒，有声音，英文）](https://cuttlely.com/media/products/testing.mp4?v=d1873063) · [用 Compare 做 A/B 测试（英文指南）](../docs/how-to/ab-testing.md)

## 快速开始

<a id="quick-start"></a>

多数人用 Docker 就好。在这份仓库的克隆里：

```bash
docker compose up -d
docker compose exec cuttlely curl -fsS http://127.0.0.1:43117/api/v1/ping
```

看到 `pong` 之后，打开 [http://localhost:43117](http://localhost:43117)。Compose 会拉取已发布的 Cuttlely 镜像；拉取不到时，会用你的克隆现场构建，第一次要几分钟。`docker compose down` 会留下你的数据。

这个容器里的数据库是 SQLite。数据卷、环境变量和 Compose 的说明在 [Docker](../docs/how-to/docker.md)。

如果你在改代码，从源码跑：[从源码运行](../docs/how-to/from-source.md)。

## 登录

<a id="sign-in"></a>

新安装没有任何用户。打开 `docker compose logs cuttlely | grep "Setup code"` 打印的设置链接，创建一个本地的所有者账号。也可以在终端里创建。

```bash
docker compose exec -u node -it -e CUTTLELY_LOCAL_ADMIN=true cuttlely pnpm user --email you@example.com
```

打开 [http://localhost:43117/signin](http://localhost:43117/signin)。密码按钮的文字是 **Sign in**。

WorkOS、团队，以及从源码创建账号，写在[登录](../docs/how-to/sign-in.md)。

## 试一试

<a id="try-it"></a>

打开 **Templates**，启动一个 harness，然后选 **Try it**。如果 Harness Prime 向你要模型密钥，先在 **Credentials** 里存一把，再在那个节点上选中它。

harness 是什么、对话流怎么调用它：[Harness](../docs/how-to/harnesses.md)。知识流水线：[ETL](../docs/how-to/etl.md)。

## 使用指南

<a id="guides"></a>

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

<a id="version-history"></a>

-   [版本历史](../docs/how-to/versioning.md)。先看[生命周期一览](../docs/how-to/versioning.md#the-lifecycle-at-a-glance)。对话流、agentflow、harness 和流水线的每个版本都会保留。对话流和 agentflow 默认开启草稿，两者都可以[在 Publish 前检查最近的问题](../docs/how-to/versioning.md#check-recent-questions-before-you-publish)。查看改了什么、和现在比较、谁改的，一键[恢复或回滚](../docs/how-to/versioning.md#restore-a-version)。所有者还可以[在 GitHub 保留一份副本](../docs/how-to/versioning.md#keep-a-copy-in-github)；也可以[把流程从 Dev 移到 Prod](../docs/how-to/versioning.md#move-a-flow-from-dev-to-prod)。
-   [历史设置](../docs/reference/versioning-settings.md)。`CUTTLELY_VERSIONS=off` 关闭历史。也说明历史仓库放在哪里。
-   [历史 API](../docs/reference/versioning-api.md)。版本历史、GitHub 副本和 Dev 到 Prod 背后的路由。
-   [草稿 API](../docs/reference/drafts-api.md)。草稿、Publish、回滚 Live 和 Publish 前检查的路由。草稿默认开启，`CUTTLELY_DRAFTS=off` 关闭草稿。
-   [版本文件](../docs/reference/version-files.md)。历史仓库里的文件和提交。

### 分析模式

<a id="analyst-mode"></a>

-   [分析模式](../docs/how-to/analyst.md)。专员可以在自己的表里建表和查询，不会去读应用的表。
-   [Docker](../docs/how-to/docker.md)。把 `CUTTLELY_ANALYST` 设成 `auto`，就会为每个工作区在 SQLite 文件旁边创建 `analyst-<tag>.db`。
-   [从源码运行](../docs/how-to/from-source.md)。`CUTTLELY_ANALYST=auto` 会为每个工作区在 SQLite 旁边创建 `analyst-<tag>.db`；如果是 Postgres，则为每个工作区创建 analyst schema 和它自己的登录账号。它不会读取应用的表。
-   [分析数据库](../docs/how-to/render.md#analyst-database)。在 Render 上，分析模式保持关闭，直到你在 Dashboard 里把 `CUTTLELY_ANALYST` 设成 `auto`。

### Agentflow

-   Agentflows 页面上的 **Add New** 打开当前的 agentflow 画布。旧版 V1 agentflow 在应用里隐藏：Add New、Duplicate 和模板都不再新建它们。已有的旧版 agentflow 仍然可以通过 API、嵌入和分享链接运行，也能从直接链接打开；工作区里有旧版 agentflow 时，它们显示在 **Legacy agentflows** 下。

## 带上已有的流程

<a id="bring-your-existing-flows"></a>

在 Chatflows 的 **Import** 菜单里，**Import Flowise JSON** 会打开一个短向导，然后进入画布。**Import Langflow JSON** 会载入一个简单对话。

能带来什么、还不支持什么：[Bring your existing flows](../docs/bring-your-flows.md)（英文）。

[Flowise 向导](../docs/flowise-migration-wizard.md) · [Langflow 导入](../docs/langflow-import.md)

## 参与贡献

<a id="contributing"></a>

见 [CONTRIBUTING.md](../CONTRIBUTING.md)。在 Node 24 上，提交拉取请求之前先跑 `pnpm verify`。安全报告请看 [SECURITY.md](../SECURITY.md)。

## 关于与致谢

<a id="about-and-credits"></a>

Cuttlely 使用 Apache 2.0。正文在 [LICENSE.md](../LICENSE.md)。署名在 [NOTICE](../NOTICE)。

Cuttlely 建立在开源成果之上，包括 Flowise、Nous Research 的 Hermes 和 React Flow。各项目的许可证和链接见 [CREDITS.md](../CREDITS.md)。
