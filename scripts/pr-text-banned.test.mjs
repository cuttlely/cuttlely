import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { bannedPhrases, findBanned, main, phrasePattern, readCheckedText } from './pr-text-banned.mjs'

const SCRIPT = fileURLToPath(new URL('./pr-text-banned.mjs', import.meta.url))

describe('pr-text-banned', () => {
    it('the checked-in list is non-empty and does not read PR_TEXT_BANNED', () => {
        const previous = process.env.PR_TEXT_BANNED
        process.env.PR_TEXT_BANNED = 'hello-from-env'
        try {
            const phrases = bannedPhrases()
            assert.ok(phrases.length > 0, 'banned phrase list is empty')
            assert.ok(!phrases.includes('hello-from-env'))
            assert.equal(process.env.PR_TEXT_BANNED, 'hello-from-env')
        } finally {
            if (previous === undefined) delete process.env.PR_TEXT_BANNED
            else process.env.PR_TEXT_BANNED = previous
        }
    })

    it('fails when the list is empty', () => {
        assert.throws(() => findBanned('clean title', []), /banned phrase list is empty/)
        assert.throws(() => findBanned('clean title', ['']), /banned phrase list is empty/)
    })

    it('flags each banned phrase in title or body and ignores clean text', () => {
        const phrases = bannedPhrases()
        assert.deepEqual(findBanned('Add watsonx Orchestrate how-to', phrases), [])
        for (const phrase of phrases) {
            const hits = findBanned(`Please do not ${phrase} this.`, phrases)
            assert.ok(hits.includes(phrase), phrase)
            assert.ok(phrasePattern(phrase).test(`wrap ${phrase} wrap`))
        }
        assert.ok(findBanned('Section \u00a7 2', phrases).includes('\u00a7'))
    })

    it('reads --title and --body, then PR_TITLE and PR_BODY, and never PR_TEXT_BANNED', () => {
        const env = { PR_TITLE: 'from-env-title', PR_BODY: 'from-env-body', PR_TEXT_BANNED: 'ignored' }
        assert.equal(readCheckedText(['--title', 'cli-title', '--body', 'cli-body'], env), 'cli-title\ncli-body')
        assert.equal(readCheckedText([], env), 'from-env-title\nfrom-env-body')
        assert.equal(main(['--title', 'Add watsonx Orchestrate how-to', '--body', 'Harbor bakery demo'], env), 0)
        const banned = bannedPhrases()[0]
        assert.equal(main(['--title', `please ${banned}`, '--body', 'ok'], {}), 1)
    })

    it('the CLI exits 1 on banned text and 0 on clean text', () => {
        const banned = bannedPhrases()[0]
        const bad = spawnSync(process.execPath, [SCRIPT, '--title', `please ${banned}`, '--body', 'ok'], { encoding: 'utf8' })
        assert.equal(bad.status, 1)
        assert.match(bad.stderr, /banned phrase/)
        const good = spawnSync(process.execPath, [SCRIPT, '--title', 'Add watsonx Orchestrate how-to', '--body', 'Harbor bakery'], {
            encoding: 'utf8',
            env: { ...process.env, PR_TEXT_BANNED: banned }
        })
        assert.equal(good.status, 0, good.stderr)
    })
})
