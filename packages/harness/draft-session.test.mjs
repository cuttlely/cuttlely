import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-draft-session-'))
process.env.CUTTLELY_DATA_DIR = root
process.env.CUTTLELY_HERMES_HOME = path.join(root, 'runtime')
const { appendTurn, closeSessions, draftSessionScope, readMessages, readPromptContext, removeDraftSessions } = await import('./session.mjs')
const { nameReuseBlockers, removeHarnessProfiles } = await import('./cleanup.mjs')
const { compileProfileCached } = await import('./profile.mjs')
const { getHarness, saveHarness } = await import('./store.mjs')
const { runHarness } = await import('./run.mjs')

after(() => {
    closeSessions()
    fs.rmSync(root, { recursive: true, force: true })
})

const record = (name) => ({
    name,
    workspaceId: 'workspace-one',
    chatflowId: 'canvas-one',
    chief: { model: { nodeName: 'chatOpenAI', inputs: { modelName: 'gpt-4.1' } } },
    specialists: [{ name: 'echo', modules: [{ nodeName: 'fixtureEcho', category: 'Tools', inputs: {} }] }]
})
const loadNode = async () =>
    class {
        async init() {
            return { name: 'fixtureEcho', invoke: async (input) => `Echo ${input}` }
        }
    }

test('previewing an unpublished harness retains draft context and leaves its name publishable', async () => {
    const draft = record('new-import')
    for (const [index, input] of ['first', 'second'].entries()) {
        const result = await runHarness({
            name: draft.name,
            record: { ...draft, tryOwner: 'user:fixture', tryId: String(index + 1).repeat(16) },
            chatId: 'same-chat',
            input,
            flowOptions: { appDataSource: {}, workspaceId: draft.workspaceId, harnessCaller: { via: 'session' } },
            loadNode
        })
        assert.equal(result.text, `Echo ${input}`)
        assert.equal(getHarness(draft.name), null)
        assert.equal(fs.existsSync(path.join(root, 'runtime', 'profiles', draft.name)), false)
    }
    const context = readPromptContext(draft.name, 'same-chat', { scope: draftSessionScope(draft) })
    assert.deepEqual(
        context.messages.map((message) => message.content),
        ['first', 'Echo first', 'second', 'Echo second']
    )
    assert.deepEqual(nameReuseBlockers(draft.name), [])
    const cleanup = await removeHarnessProfiles(draft.name)
    assert.equal(cleanup.error, null)
    assert.deepEqual(cleanup.kept, [])
    const saved = saveHarness(draft)
    compileProfileCached(saved)
    assert.equal(getHarness(draft.name).chatflowId, draft.chatflowId)
})

test('draft sessions isolate equal harness and chat names by workspace and canvas', () => {
    const draft = record('isolated-import')
    const scope = draftSessionScope(draft)
    appendTurn(draft.name, 'chat', 'private question', 'answer', [], undefined, { scope })
    for (const other of [
        { ...draft, workspaceId: 'workspace-two' },
        { ...draft, chatflowId: 'canvas-two' }
    ]) {
        assert.deepEqual(readPromptContext(draft.name, 'chat', { scope: draftSessionScope(other) }).messages, [])
    }
    assert.deepEqual(readMessages(draft.name, 'chat'), [])
    assert.equal(readMessages(draft.name, 'chat', undefined, { scope }).length, 2)
})

test('existing published sessions keep their current profile path during canvas previews', async () => {
    const published = saveHarness(record('published-import'))
    compileProfileCached(published)
    appendTurn(published.name, 'chat', 'before preview', 'prior answer')
    const result = await runHarness({
        name: published.name,
        record: { ...published, tryOwner: 'user:fixture', tryId: '3333333333333333' },
        chatId: 'chat',
        input: 'after',
        flowOptions: { appDataSource: {}, workspaceId: published.workspaceId, harnessCaller: { via: 'session' } },
        loadNode
    })
    assert.equal(result.text, 'Echo after')
    assert.deepEqual(
        readMessages(published.name, 'chat').map((message) => message.content),
        ['before preview', 'prior answer', 'after', 'Echo after']
    )
    assert.equal(fs.existsSync(path.join(root, 'runtime', 'profiles', published.name, 'sessions.sqlite')), true)
})

test('draft session storage refuses linked directories and linked SQLite files', () => {
    const draft = { ...record('linked-import'), chatflowId: 'linked-canvas' }
    const scope = draftSessionScope(draft)
    const target = path.join(root, 'untouched')
    fs.mkdirSync(target)
    const dir = path.join(root, 'harness-draft-sessions', scope)
    fs.symlinkSync(target, dir)
    assert.throws(() => appendTurn(draft.name, 'chat', 'question', 'answer', [], undefined, { scope }), /plain directory/)
    assert.deepEqual(fs.readdirSync(target), [])
    fs.unlinkSync(dir)
    fs.mkdirSync(dir)
    fs.symlinkSync(path.join(target, 'precious.sqlite'), path.join(dir, 'sessions.sqlite'))
    assert.throws(() => appendTurn(draft.name, 'chat', 'question', 'answer', [], undefined, { scope }), /plain file/)
    assert.deepEqual(fs.readdirSync(target), [])
})

test('a different saved canvas never redirects an in-memory draft into its published session', async () => {
    const draft = record('occupied-import')
    const saved = saveHarness({ ...draft, workspaceId: 'workspace-two', chatflowId: 'canvas-two' })
    compileProfileCached(saved)
    appendTurn(saved.name, 'chat', 'other team question', 'other team answer')
    await runHarness({
        name: draft.name,
        record: { ...draft, tryOwner: 'user:fixture', tryId: '4444444444444444' },
        chatId: 'chat',
        input: 'own draft question',
        flowOptions: { appDataSource: {}, workspaceId: draft.workspaceId, harnessCaller: { via: 'session' } },
        loadNode
    })
    assert.deepEqual(
        readMessages(saved.name, 'chat').map((message) => message.content),
        ['other team question', 'other team answer']
    )
    assert.deepEqual(
        readPromptContext(draft.name, 'chat', { scope: draftSessionScope(draft) }).messages.map((message) => message.content),
        ['own draft question', 'Echo own draft question']
    )
})

test('deleting draft sessions closes only that canvas and never removes a sibling scope', () => {
    const draft = { ...record('deleted-import'), chatflowId: 'deleted-canvas' }
    const other = { ...draft, chatflowId: 'retained-canvas' }
    for (const canvas of [draft, other])
        appendTurn(canvas.name, 'chat', 'question', 'answer', [], undefined, { scope: draftSessionScope(canvas) })
    removeDraftSessions(draft)
    assert.deepEqual(readPromptContext(draft.name, 'chat', { scope: draftSessionScope(draft) }).messages, [])
    assert.equal(readPromptContext(other.name, 'chat', { scope: draftSessionScope(other) }).messages.length, 2)
    removeDraftSessions({ ...draft, chatflowId: 'never-created' })
    assert.equal(readPromptContext(other.name, 'chat', { scope: draftSessionScope(other) }).messages.length, 2)
})
