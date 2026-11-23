// Independent examples of the release-facing surfaces, rather than generating
// fixture text from the check's selectors (which could hide a missing selector).
export const RELEASE_DOC_FIXTURE = {
    'package.json': JSON.stringify({ version: '2.3.4' }),
    'website/src/components/Hero.astro': '<p><strong>New in 2.3.4:</strong> Current features.</p>\n',
    'FAQ.md': '# Cuttlely FAQ (2.3.4)\n',
    'AGENTS.md': '# Agent instructions for Cuttlely\n\nCuttlely 2.3.4 gives applications agent teams.\n',
    'README.md':
        '# Cuttlely\n\n**2.3.4 adds current features.**\n\nLatest stable is **2.3.4**. Pin image `2.3.4` or install `cuttlely@2.3.4`.\n',
    'README.ja.md': '# Cuttlely\n\n**2.3.4 では、新しい機能を追加しました。**\n\n最新の安定版は **2.3.4** です。`cuttlely@2.3.4`。\n',
    'README.ko.md': '# Cuttlely\n\n**2.3.4에서는 새로운 기능을 추가합니다.**\n\n최신 안정 버전은 **2.3.4**입니다. `cuttlely@2.3.4`.\n',
    'i18n/README-ZH.md': '# Cuttlely\n\n最新稳定版是 **2.3.4**。`cuttlely@2.3.4`。\n',
    'i18n/README-TW.md': '# Cuttlely\n\n最新穩定版是 **2.3.4**。`cuttlely@2.3.4`。\n',
    'docs/how-to/README.md': '# How-to guides\n\n## New in 2.3.4\n\nCurrent features.\n',
    'docs/how-to/docker.md':
        '# Docker\n\nUse `ghcr.io/cuttlely/cuttlely:latest` by default.\n\n- **Pin a release.** Set `CUTTLELY_IMAGE=ghcr.io/cuttlely/cuttlely:X.Y.Z`, for example `ghcr.io/cuttlely/cuttlely:2.3.4`.\n',
    'docs/how-to/share-and-embed.md': '# Embed\n\nPin `npm install @cuttlely/chat@2.3.4` for a 2.3.4 server.\n',
    '.env.example': '# CUTTLELY_IMAGE=ghcr.io/cuttlely/cuttlely:2.3.4\n',
    'docker-compose.yml':
        '# CUTTLELY_IMAGE=ghcr.io/cuttlely/cuttlely:2.3.4    pin the 2.3.4 release image\nservices:\n  cuttlely:\n    image: ${CUTTLELY_IMAGE:-ghcr.io/cuttlely/cuttlely:latest}\n'
}
