import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
    GITHUB_PAGE_HINT,
    HTTPS_ONLY,
    LIST_REFS_HINT,
    MISSING_BRANCH_HINT,
    PRIVATE_ADDRESS,
    SLASH_BRANCH_HINT,
    SSH_HINT,
    TRAVERSAL_HINT,
    WEB_PAGE_HINT,
    CREDENTIALS_HINT,
    gitUrlHint,
    inspectGitUrl,
    parseRemoteRefs,
    resolveGitSource,
    resolveRest,
    safeSubPath
} from './git-url.mjs'

describe('inspectGitUrl', () => {
    it('accepts a plain https repository URL and a .git URL', () => {
        const plain = inspectGitUrl('https://github.com/hashicorp/web-unified-docs')
        assert.equal(plain.ok, true)
        assert.equal(plain.kind, 'repo')
        assert.equal(plain.cloneUrl, 'https://github.com/hashicorp/web-unified-docs.git')
        const dotted = inspectGitUrl('https://github.com/hashicorp/web-unified-docs.git')
        assert.equal(dotted.ok, true)
        assert.equal(dotted.cloneUrl, 'https://github.com/hashicorp/web-unified-docs.git')
        const other = inspectGitUrl('https://example.com/org/repo.git')
        assert.equal(other.ok, true)
        assert.equal(other.kind, 'repo')
        assert.equal(other.cloneUrl, 'https://example.com/org/repo.git')
    })

    it('turns a GitHub folder link into the repo, branch rest, and path', () => {
        const got = inspectGitUrl('https://github.com/hashicorp/web-unified-docs/tree/main/content/')
        assert.equal(got.ok, true)
        assert.equal(got.kind, 'tree')
        assert.equal(got.cloneUrl, 'https://github.com/hashicorp/web-unified-docs.git')
        assert.equal(got.rest, 'main/content')
    })

    it('turns a GitHub file link into a blob rest', () => {
        const got = inspectGitUrl('https://github.com/hashicorp/web-unified-docs/blob/main/README.md')
        assert.equal(got.ok, true)
        assert.equal(got.kind, 'blob')
        assert.equal(got.cloneUrl, 'https://github.com/hashicorp/web-unified-docs.git')
        assert.equal(got.rest, 'main/README.md')
    })

    it('decodes each URL path component once', async () => {
        const percent = await resolveGitSource({
            gitUrl: 'https://github.com/org/repo/blob/main/100%25.md',
            listRefs: async () => new Set(['main'])
        })
        assert.equal(percent.subPath, '100%.md')
        const escapedText = await resolveGitSource({
            gitUrl: 'https://github.com/org/repo/blob/main/literal%2520name.md',
            listRefs: async () => new Set(['main'])
        })
        assert.equal(escapedText.subPath, 'literal%20name.md')
    })

    it('treats www.github.com as github.com and ignores query and hash', () => {
        const got = inspectGitUrl('https://www.github.com/org/repo/tree/main/docs?tab=readme#anchor')
        assert.equal(got.ok, true)
        assert.equal(got.cloneUrl, 'https://github.com/org/repo.git')
        assert.equal(got.rest, 'main/docs')
    })

    it('rejects SSH, http, private addresses, and credentials', () => {
        assert.equal(gitUrlHint('git@github.com:org/repo.git'), SSH_HINT)
        assert.equal(gitUrlHint('ssh://git@github.com/org/repo.git'), SSH_HINT)
        assert.equal(gitUrlHint('http://github.com/org/repo.git'), HTTPS_ONLY)
        assert.equal(gitUrlHint('https://127.0.0.1/org/repo.git'), PRIVATE_ADDRESS)
        assert.equal(gitUrlHint('https://192.168.1.4/org/repo.git'), PRIVATE_ADDRESS)
        assert.equal(gitUrlHint('https://user:pass@github.com/org/repo.git'), CREDENTIALS_HINT)
        assert.equal(gitUrlHint(''), '')
        assert.match(gitUrlHint('not a url'), /is not a git URL/)
    })

    it('hints when a GitHub or other web page cannot be cloned', () => {
        assert.equal(gitUrlHint('https://github.com/hashicorp/web-unified-docs/issues/1'), GITHUB_PAGE_HINT)
        assert.equal(gitUrlHint('https://github.com/org/repo/pull/3'), GITHUB_PAGE_HINT)
        assert.equal(gitUrlHint('https://github.com/org/repo/commit/abc'), GITHUB_PAGE_HINT)
        assert.equal(gitUrlHint('https://github.com/org/repo/tree'), MISSING_BRANCH_HINT)
        assert.equal(gitUrlHint('https://gitlab.com/org/repo/tree/main/docs'), WEB_PAGE_HINT)
    })

    it('rejects a path that leaves the repository', () => {
        assert.equal(gitUrlHint('https://github.com/org/repo/tree/main/%2e%2e%2fsecret'), TRAVERSAL_HINT)
        assert.equal(gitUrlHint('https://github.com/org/repo/tree/main/foo%2f..%2f..%2fsecret'), TRAVERSAL_HINT)
        assert.throws(
            () => safeSubPath('../etc'),
            (err) => err.code === 'bad_source' && err.message === TRAVERSAL_HINT
        )
        assert.throws(() => safeSubPath('foo/../../../etc'))
        assert.equal(safeSubPath('content/guides/'), 'content/guides')
        assert.equal(safeSubPath('a/./b'), 'a/b')
    })
})

describe('resolveRest', () => {
    it('uses the first segment when the branch has no slashes', () => {
        assert.deepEqual(resolveRest('main/content'), { branch: 'main', subPath: 'content' })
        assert.deepEqual(resolveRest('main'), { branch: 'main', subPath: '' })
    })

    it('picks the longest matching ref when a branch name has slashes', () => {
        const refs = new Set(['release', 'release/1.7.2', 'main'])
        assert.deepEqual(resolveRest('release/1.7.2/docs/etl.md', { refs }), {
            branch: 'release/1.7.2',
            subPath: 'docs/etl.md'
        })
        assert.deepEqual(resolveRest('main/content', { refs }), { branch: 'main', subPath: 'content' })
        assert.throws(
            () => resolveRest('unknown/path', { refs }),
            (err) => err.message === SLASH_BRANCH_HINT
        )
    })

    it('lets an explicit Branch field win', () => {
        assert.deepEqual(resolveRest('main/content', { branch: 'main' }), { branch: 'main', subPath: 'content' })
        assert.deepEqual(resolveRest('release/1.7.2/docs', { branch: 'release/1.7.2' }), {
            branch: 'release/1.7.2',
            subPath: 'docs'
        })
        assert.deepEqual(resolveRest('main/content', { branch: 'develop' }), { branch: 'develop', subPath: 'content' })
        assert.throws(
            () => resolveRest('main/content', { branch: '-bad' }),
            (err) => err.code === 'bad_source'
        )
    })
})

describe('parseRemoteRefs and resolveGitSource', () => {
    it('reads heads and tags from ls-remote output, including peeled tags', () => {
        const refs = parseRemoteRefs(
            ['aaa\trefs/heads/main', 'bbb\trefs/heads/release/1.7.2', 'ccc\trefs/tags/v1.0', 'ddd\trefs/tags/v1.0^{}'].join('\n')
        )
        assert.deepEqual([...refs].sort(), ['main', 'release/1.7.2', 'v1.0'])
    })

    it('clones the repo URL and loads the folder from a GitHub tree link', async () => {
        const got = await resolveGitSource({
            gitUrl: 'https://github.com/hashicorp/web-unified-docs/tree/main/content/',
            listRefs: async () => new Set(['main', 'develop'])
        })
        assert.deepEqual(got, {
            cloneUrl: 'https://github.com/hashicorp/web-unified-docs.git',
            branch: 'main',
            subPath: 'content',
            kind: 'tree'
        })
    })

    it('resolves a slash branch with injected refs and keeps a plain repo URL', async () => {
        const slash = await resolveGitSource({
            gitUrl: 'https://github.com/org/repo/tree/release/1.7.2/docs',
            listRefs: async () => new Set(['release/1.7.2', 'main'])
        })
        assert.equal(slash.branch, 'release/1.7.2')
        assert.equal(slash.subPath, 'docs')
        const plain = await resolveGitSource({
            gitUrl: 'https://example.com/org/repo.git',
            branch: 'main'
        })
        assert.deepEqual(plain, { cloneUrl: 'https://example.com/org/repo.git', branch: 'main', subPath: '', kind: 'repo' })
    })

    it('resolves the link ref before applying a Branch override', async () => {
        let called = false
        const got = await resolveGitSource({
            gitUrl: 'https://github.com/org/repo/tree/release/1.7.2/docs',
            branch: 'release/1.7.2',
            listRefs: async () => {
                called = true
                return new Set(['release/1.7.2', 'main'])
            }
        })
        assert.equal(called, true)
        assert.equal(got.branch, 'release/1.7.2')
        assert.equal(got.subPath, 'docs')
        const overridden = await resolveGitSource({
            gitUrl: 'https://github.com/org/repo/tree/release/1.7.2/docs',
            branch: 'main',
            listRefs: async () => {
                called = true
                return new Set(['release/1.7.2', 'main'])
            }
        })
        assert.equal(called, true)
        assert.equal(overridden.branch, 'main')
        assert.equal(overridden.subPath, 'docs')
    })

    it('does not mistake a Branch override for the prefix of a slash branch', async () => {
        let called = false
        const got = await resolveGitSource({
            gitUrl: 'https://github.com/org/repo/tree/release/1.7.2/docs',
            branch: 'release',
            listRefs: async () => {
                called = true
                return new Set(['release', 'release/1.7.2', 'main'])
            }
        })
        assert.equal(called, true)
        assert.equal(got.branch, 'release')
        assert.equal(got.subPath, 'docs')
    })

    it('hints when listing refs fails', async () => {
        await assert.rejects(
            () =>
                resolveGitSource({
                    gitUrl: 'https://github.com/org/repo/tree/release/1.7.2/docs',
                    listRefs: async () => {
                        throw new Error('network')
                    }
                }),
            (err) => err.message === LIST_REFS_HINT
        )
    })

    it('keeps a hostile branch from reaching git', async () => {
        await assert.rejects(
            () => resolveGitSource({ gitUrl: 'https://example.com/r.git', branch: '--upload-pack=touch pwned' }),
            (err) => err.code === 'bad_source'
        )
    })
})
