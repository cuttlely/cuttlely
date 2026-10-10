<p align="center">
<picture>
<source media="(prefers-color-scheme: dark)" srcset="../assets/brand/readme/cuttlely-readme-header-dark.png">
<img src="../assets/brand/readme/cuttlely-readme-header-light.png" alt="Cuttlely. Your applications deserve agents. The open-source agent platform for applications." width="880">
</picture>
</p>

# Cuttlely

**애플리케이션에도 에이전트가 필요합니다.**

애플리케이션을 위한 오픈 소스 에이전트 플랫폼. 몇 분이면 팀과 대화를 시작하고, 이어서 앱에서 바로 호출할 수 있습니다. 모든 것은 내가 관리하는 인프라에서 실행됩니다.

에이전트 팀은 리더 에이전트와 전문가들로 이루어집니다. 리더인 Harness Prime이 질문을 여러 부분으로 나누면, 전문가들이 각자의 모델, 도구, 데이터로 일을 처리하고, 분석가는 실제 테이블을 조회해 진짜 숫자를 돌려줍니다. 앱은 API로 팀에 질문을 보내고, 충분히 조사한 하나의 답, 차트 또는 액션을 돌려받습니다. Cuttlely에서는 에이전트 팀을 harness라고 부릅니다. 지식 파이프라인, 비주얼 워크플로, Build with AI가 팀에 필요한 것을 마련해 주고, 모든 변경은 여러분이 게시(Publish)할 때까지 초안으로 기다립니다. Cuttlely는 오픈 소스이며 노트북, 내 서버, Render에서 실행됩니다.

> 기능 목록([앱에서 팀 사용하기](../README.md#use-a-team-from-your-app)의 API 예시 포함), 릴리스 흐름(Ship changes safely), "처음 10분(Your first 10 minutes)"은 지금은 [영어 README](../README.md)에만 있습니다.

처음 설치는 **SQLite**를 씁니다. `DATABASE_TYPE`은 비워 두세요. 노트북에 Postgres를 깔 필요는 없습니다. Docker는 SQLite를 유지합니다. 소스에서 실행할 때는 Postgres를 고를 수 있고, 공개 호스트에서는 Render Blueprint가 Postgres를 넣습니다. 경로별 단계는 [사용 안내](#사용-안내)에 있습니다.

chief-of-staff의 분석가는 `CUTTLELY_ANALYST=auto`로 두기 전까지 꺼져 있습니다. 켜면 워크스페이스마다 앱과 분리된 저장소가 생깁니다. SQLite 파일 옆의 `analyst-<tag>.db`이거나, Postgres에서는 워크스페이스별 스키마와 그 전용 로그인입니다(`<tag>`는 워크스페이스 ID에서 만들어집니다). 한 워크스페이스에서 만든 테이블은 다른 워크스페이스의 분석가에게 보이지 않습니다. 앱 테이블은 읽지 않습니다. 자격 증명의 Postgres URL이나, 다른 데이터베이스를 가리키는 `CUTTLELY_POSTGRES_URL`이 있으면 그쪽이 우선합니다. 단계는 [분석 모드](#분석-모드)에 있습니다.

플로우의 모든 버전이 남고, 변경 사항은 여러분이 정할 때만 사용하는 사람에게 전달됩니다. 채팅 플로우와 에이전트 플로우 캔버스는 기본으로 **초안**에 저장되고, API, 임베드, 공유 링크는 계속 **Live** 버전으로 동작합니다. 채팅 플로우나 에이전트 플로우를 **Publish**하기 전에 Cuttlely는 최근의 실제 질문 몇 개를 Live와 초안에 다시 물어 답을 나란히 보여 줄 수 있습니다. **Version history**에서는 무엇이 바뀌었고 누가 바꿨는지 보이며, 예전 버전 복원이나 Live 되돌리기는 클릭 한 번이면 됩니다. 소유자는 자신의 GitHub 저장소에 사본을 둘 수도 있습니다. 브라우저에서 첫 계정을 만든 직후 한 번 안내되고, 언제든 **Admin**, **Version History**에서 설정할 수 있습니다. 이 사본으로 플로우를 Dev 서버에서 Prod 서버로 옮길 수 있으며, 서버마다 자기 자격 증명을 따로 가집니다. 기록은 여러분의 서버, 데이터 옆의 Git 저장소에 남습니다. 자격 증명은 이름만 기록되고, 프롬프트에서 비밀처럼 보이는 글자는 기록에 남지 않습니다. 단계는 [버전 기록](#버전-기록)에 있습니다.

[English](../README.md) | [繁體中文](./README-TW.md) | [简体中文](./README-ZH.md) | [日本語](./README-JA.md) | 한국어

영어 README가 원문입니다. 내용이 다르면 영어판을 따르세요.

## 목차

-   [바로 시작하기](#바로-시작하기)
-   [사용 안내](#사용-안내)
-   [로그인](#로그인)
-   [한번 써 보기](#한번-써-보기)
-   [가지고 있는 플로우 가져오기](#가지고-있는-플로우-가져오기)
-   [기여하기](#기여하기)
-   [소개와 크레디트](#소개와-크레디트)

## 바로 시작하기

대부분의 사람에게는 Docker가 맞습니다. 이 저장소를 복제한 곳에서:

```bash
docker compose up -d
docker compose exec cuttlely curl -fsS http://127.0.0.1:43117/api/v1/ping
```

`pong`이 나오면 [http://localhost:43117](http://localhost:43117)을 엽니다. Compose는 공개된 Cuttlely 이미지를 받아 옵니다. 받아 올 수 없으면 복제본에서 이미지를 빌드하므로 처음에는 몇 분 걸립니다. `docker compose down`은 데이터를 남깁니다.

그 컨테이너의 데이터베이스는 SQLite입니다. 볼륨, 환경 변수, Compose 메모는 [Docker](../docs/how-to/docker.md)에 있습니다.

코드를 고친다면 소스에서: [소스에서 실행](../docs/how-to/from-source.md).

## 사용 안내

Cuttlely를 설치하고 쓰는 안내입니다. 코드를 바꾸지 않는다면 Docker부터 시작하세요.

### 설치와 배포

-   [Docker](../docs/how-to/docker.md). Compose가 이 저장소를 빌드합니다. 앱 데이터베이스는 SQLite이고, Compose는 Postgres를 시작하지 않습니다.
-   [소스에서 실행](../docs/how-to/from-source.md). Cuttlely를 고칠 때 씁니다. 그냥 혼자 돌릴 때는 Docker입니다.
-   [Render](../docs/how-to/render.md). Cuttlely를 Render에 올릴 때 씁니다. 노트북 설치는 SQLite를 유지합니다. 이 Blueprint는 Postgres를 설정합니다.

### 로그인 방법

-   [로그인](../docs/how-to/sign-in.md). 새 설치에는 사용자가 없습니다. 로컬 계정을 하나 만든 다음 앱을 엽니다. WorkOS는 팀을 위한 것이고, 그게 된 뒤에 씁니다.
-   [WorkOS AuthKit 설정](../docs/identity/workos-authkit-setup.md). Cuttlely 설치를 WorkOS AuthKit에 단계대로 연결합니다.

### 하네스와 파이프라인

-   [하네스](../docs/how-to/harnesses.md). 하네스는 Harness Prime과 한 명 이상의 전문가입니다. 채팅 플로우는 그 팀을 이름으로 부릅니다.
-   [ETL](../docs/how-to/etl.md). 사이드바의 ETL은 채팅 플로우 옆의 파이프라인입니다. 로더, 변환, 저장소로 이루어집니다.

### 버전 기록

-   [버전 기록](../docs/how-to/versioning.md). 먼저 [한눈에 보는 수명 주기](../docs/how-to/versioning.md#the-lifecycle-at-a-glance)를 보세요. 채팅 플로우, 에이전트 플로우, 하네스, 파이프라인의 모든 버전이 남습니다. 채팅 플로우와 에이전트 플로우는 기본으로 초안이 켜져 있고, 둘 다 [Publish 전에 최근 질문을 확인](../docs/how-to/versioning.md#check-recent-questions-before-you-publish)할 수 있습니다. 무엇이 바뀌었는지, 지금과 비교, 누가 바꿨는지 보고 클릭 한 번으로 [복원하거나 되돌릴](../docs/how-to/versioning.md#restore-a-version) 수 있습니다. 소유자는 [GitHub에 사본을 둘](../docs/how-to/versioning.md#keep-a-copy-in-github) 수도 있습니다. [플로우를 Dev에서 Prod로 옮길](../docs/how-to/versioning.md#move-a-flow-from-dev-to-prod) 수도 있습니다.
-   [기록 설정](../docs/reference/versioning-settings.md). `CUTTLELY_VERSIONS=off`로 기록을 끕니다. 기록 저장소가 어디에 있는지도 설명합니다.
-   [기록 API](../docs/reference/versioning-api.md). 버전 기록, GitHub 사본, Dev에서 Prod로 옮기기를 뒷받침하는 경로입니다.
-   [초안 API](../docs/reference/drafts-api.md). 초안, Publish, Live 되돌리기, Publish 전 확인의 경로입니다. 초안은 기본으로 켜져 있고, `CUTTLELY_DRAFTS=off`로 끕니다.
-   [버전 파일](../docs/reference/version-files.md). 기록 저장소의 파일과 커밋입니다.

### 분석 모드

-   [분석 모드](../docs/how-to/analyst.md). 전문가가 자기 테이블을 만들고 조회합니다. 앱 테이블은 읽지 않습니다.
-   [Docker](../docs/how-to/docker.md). `CUTTLELY_ANALYST`를 `auto`로 두면 워크스페이스마다 SQLite 파일 옆에 `analyst-<tag>.db`가 생깁니다.
-   [소스에서 실행](../docs/how-to/from-source.md). `CUTTLELY_ANALYST=auto`는 워크스페이스마다 SQLite 옆에 `analyst-<tag>.db`를 만들거나, Postgres에서는 분석가 스키마와 전용 로그인을 만듭니다. 앱 테이블은 읽지 않습니다.
-   [분석 데이터베이스](../docs/how-to/render.md#analyst-database). Render에서는 Dashboard에서 `CUTTLELY_ANALYST`를 `auto`로 두기 전까지 분석 모드가 꺼져 있습니다.

### 에이전트 플로우

-   Agentflows의 **Add New**는 현재 에이전트 플로우 캔버스를 엽니다. 예전 V1 에이전트 플로우는 앱에서 숨겨집니다. Add New, Duplicate, 템플릿으로는 더 이상 새로 만들지 않습니다.기존의 예전 에이전트 플로우는 API, 임베드, 공유 링크로 계속 동작하고, 직접 링크로도 열리며, 워크스페이스에 있으면 **Legacy agentflows** 아래에 나타납니다.

## 로그인

새로 설치하면 사용자가 없습니다. `docker compose logs cuttlely`에 나오는 설정 링크를 열어 소유자 로컬 계정을 하나 만듭니다. 터미널에서 만들 수도 있습니다.

```bash
docker compose exec -u node -it Cuttlely pnpm user --email you@example.com
```

[http://localhost:43117/signin](http://localhost:43117/signin)으로 갑니다. 비밀번호 버튼 글자는 **Sign in**입니다.

WorkOS, 팀, 소스에서 만드는 계정은 [로그인](../docs/how-to/sign-in.md)에 있습니다.

## 한번 써 보기

**Templates**를 열고 하네스를 시작한 다음 **Try it**을 고릅니다. Harness Prime이 모델 키를 묻면 **Credentials**에 저장하고 그 노드에서 선택합니다.

하네스가 무엇인지, 채팅 플로우가 어떻게 부르는지: [하네스](../docs/how-to/harnesses.md). 지식 파이프라인: [ETL](../docs/how-to/etl.md).

## 가지고 있는 플로우 가져오기

Chatflows의 **Import** 메뉴에서 **Import Flowise JSON**은 짧은 마법사를 연 다음 캔버스로 갑니다. **Import Langflow JSON**은 단순한 채팅을 읽습니다.

무엇을 가져올 수 있고 무엇이 아직 안 되는지: [Bring your existing flows](../docs/bring-your-flows.md)(영어).

[Flowise 마법사](../docs/flowise-migration-wizard.md) · [Langflow 가져오기](../docs/langflow-import.md)

## 기여하기

[CONTRIBUTING.md](../CONTRIBUTING.md)를 보세요. Node 24에서는 풀 리퀘스트 전에 `pnpm verify`를 실행합니다. 보안 보고는 [SECURITY.md](../SECURITY.md)로 보냅니다.

## 소개와 크레디트

Cuttlely는 Apache 2.0입니다. 본문은 [LICENSE.md](../LICENSE.md)에 있습니다. 출처 표기는 [NOTICE](../NOTICE)입니다.

Cuttlely는 Flowise, Nous Research의 Hermes, React Flow 등 오픈 소스 성과를 바탕으로 합니다. 각 프로젝트의 라이선스와 링크는 [CREDITS.md](../CREDITS.md)에 있습니다.
