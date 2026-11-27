import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { profileDir } from '../paths.mjs'
import { playbookMarkdown, PLAYBOOK_DIR, specialistProfileName } from '../profile.mjs'
import { specialistSessionId } from '../specialist-run.mjs'
import { assignedPlaybookFile, prepareNativePlaybooks, readPlaybookTool } from '../runtime/native-playbooks.mjs'

test('native skills expand the admitted session, serve only assigned immutable text and preserve raw reads', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'playbook-scope-'))
    const env = {
        CUTTLELY_HERMES_HOME: root,
        HERMES_MANAGED_DIR: path.join(root, 'managed'),
        CUTTLELY_HOST_FILE_MANIFEST: path.join(root, 'manifest.json')
    }
    for (const [key, value] of Object.entries(env)) {
        const old = process.env[key]
        process.env[key] = value
        t.after(() => {
            if (old === undefined) delete process.env[key]
            else process.env[key] = old
        })
    }
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const book = {
        name: 'sample',
        description: 'QA',
        content: 'Run ${HERMES_SESSION_ID}. Read ${HERMES_SKILL_DIR}/references/guide.md and ${HERMES_SKILL_DIR}/SKILL.md.'
    }
    const team = { name: 'qa', workspaceId: 'workspace', chatflowId: 'canvas', createdAt: 'generation' }
    const member = { name: 'reader', playbooks: [book] }
    const profile = specialistProfileName(team.name, member.name)
    const folder = path.join(profileDir(profile), 'skills', PLAYBOOK_DIR, book.name)
    fs.mkdirSync(path.join(folder, 'references'), { recursive: true })
    fs.mkdirSync(path.join(folder, 'templates'), { recursive: true })
    const marker = 'UTF-8 café\r\nSecond line.\r\n${HERMES_SESSION_ID}'
    const body = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(marker)])
    const guide = path.join(folder, 'references/guide.md')
    fs.writeFileSync(guide, body)
    fs.writeFileSync(path.join(folder, 'notes.env'), 'ignore')
    const scoped = {
        path: 'runtime/profiles/' + profile + '/skills/' + PLAYBOOK_DIR + '/' + book.name + '/references/guide.md',
        sha256: createHash('sha256').update(body).digest('hex'),
        playbook: { workspaceId: team.workspaceId, chatflowId: team.chatflowId, generation: team.createdAt }
    }
    const manifest = (...rows) => fs.writeFileSync(env.CUTTLELY_HOST_FILE_MANIFEST, JSON.stringify(rows))
    const open = (r = team, m = member) => prepareNativePlaybooks(r, m, 'chat', 'turn')
    const view = (state, args = {}) => readPlaybookTool([book], 'skill_view', { name: book.name, ...args }, 0, state)
    manifest(scoped, { path: '/unrelated/never-read', sha256: '0'.repeat(64) })
    let state = open()
    assert.deepEqual(state.gaps, [])
    const virtual = '/skills/' + PLAYBOOK_DIR + '/' + book.name
    const shown = view(state)
    assert.deepEqual(shown.linked_files, { references: ['references/guide.md'] })
    assert.equal(
        shown.content,
        playbookMarkdown(book)
            .replaceAll('${HERMES_SESSION_ID}', specialistSessionId(profile, 'chat', 'turn'))
            .replaceAll('${HERMES_SKILL_DIR}', virtual)
    )
    assert.equal(view(state, { file_path: 'SKILL.md' }).content, playbookMarkdown(book))
    assert.equal(view(state, { file_path: virtual + '/references/guide.md' }).content, marker.replaceAll('\r\n', '\n'))
    assert.deepEqual(assignedPlaybookFile([book], state, virtual + '/references/guide.md'), {
        path: 'references/guide.md',
        content: marker.replaceAll('\r\n', '\n')
    })
    for (const file of [
        '../guide.md',
        'notes.env',
        virtual + '/../sample/SKILL.md',
        guide,
        virtual + '/references/../references/guide.md',
        '/skills/' + PLAYBOOK_DIR + '/other/SKILL.md'
    ]) {
        assert.equal(view(state, { file_path: file }).success, false)
        assert.equal(assignedPlaybookFile([book], state, file), null)
    }
    const next = prepareNativePlaybooks(team, member, 'chat', 'next')
    assert.notEqual(view(next).content, shown.content)
    manifest({ ...scoped, playbook: { ...scoped.playbook, generation: 'retired' } })
    assert.ok(open().gaps.length)
    assert.ok(open({ ...team, workspaceId: 'other' }).gaps.length)
    manifest({ ...scoped, sha256: '0'.repeat(64) })
    assert.ok(open().gaps.length)
    manifest(scoped)
    fs.renameSync(path.join(folder, 'references'), path.join(root, 'other'))
    fs.symlinkSync(path.join(root, 'other'), path.join(folder, 'references'))
    assert.ok(open().gaps.length)
    fs.unlinkSync(path.join(folder, 'references'))
    fs.renameSync(path.join(root, 'other'), path.join(folder, 'references'))
    const legacy = { path: scoped.path, sha256: scoped.sha256 }
    const ownerGap = 'playbook host manifest needs a canvas owner binding'
    manifest(legacy)
    assert.ok(open().gaps.includes(ownerGap))
    fs.mkdirSync(profileDir(team.name), { recursive: true })
    fs.writeFileSync(path.join(profileDir(profile), 'harness-parent'), team.name)
    const ownerFile = path.join(profileDir(team.name), 'harness-roster.json')
    const snapshot = JSON.stringify({ ...team, specialists: [{ name: member.name, profileName: profile, playbooks: [book] }] })
    fs.writeFileSync(ownerFile, snapshot)
    assert.ok(open().gaps.includes(ownerGap), 'an unpinned compiler marker cannot establish which generation owns a declaration')
    const ownerPin = {
        path: 'runtime/profiles/' + team.name + '/harness-roster.json',
        sha256: createHash('sha256').update(snapshot).digest('hex')
    }
    manifest(legacy, ownerPin)
    assert.deepEqual(open().gaps, [])
    // Restore exactly the files that the deployment and encrypted runtime backup can supply.
    fs.rmSync(path.join(root, 'profiles'), { recursive: true })
    fs.mkdirSync(path.dirname(guide), { recursive: true })
    fs.mkdirSync(path.dirname(ownerFile), { recursive: true })
    fs.writeFileSync(guide, body)
    fs.writeFileSync(ownerFile, snapshot)
    assert.deepEqual(open().gaps, [])
    const replacement = { ...team, workspaceId: 'another', chatflowId: 'other', createdAt: 'replacement' }
    fs.writeFileSync(path.join(profileDir(profile), 'harness-parent'), team.name)
    fs.writeFileSync(
        ownerFile,
        JSON.stringify({ ...replacement, specialists: [{ name: member.name, profileName: profile, playbooks: [book] }] })
    )
    assert.ok(
        open(replacement).gaps.includes(ownerGap),
        'recreating a canvas under the original published name does not reassign its files'
    )
    manifest(scoped)
    assert.ok(open(replacement).gaps.length)
    assert.deepEqual(open().gaps, [])
    manifest()
    for (const content of [
        'Accounting tracks assets/liabilities quarterly.',
        'Colleagues who read references/howto.md in their old project can skip this introduction.',
        'Do not run scripts/obsolete.py.',
        '[Read references/howto.md](https://example.invalid/overview)',
        'The operator describes https://example.invalid/${HERMES_SKILL_DIR}/scripts/example.py.',
        'Further reading at https://example.invalid/references/manual.md and [site](https://example.invalid/scripts/sample.py).',
        'Example syntax: ```\nplaceholder\n```',
        ['Example only:', '```bash', 'Read references/manual.md', 'python ${HERMES_SKILL_DIR}/scripts/unused.py', '```'].join('\n'),
        '[unused]: references/unused.md',
        'Someone who read references/example.md wrote the old guide.',
        'You should not open references/unused.md.',
        'You must not read `references/unused.md`.',
        'Older guides used the example `scripts/obsolete.py`.'
    ]) {
        const checkBook = { ...book, content }
        assert.deepEqual(open(team, { ...member, playbooks: [checkBook] }).gaps, [])
    }
    const literal = { ...book, content: 'Documentation example !`read references/unused.md`.' }
    const rendered = open(team, { ...member, playbooks: [literal] })
    assert.deepEqual(rendered.gaps, [])
    assert.equal(readPlaybookTool([literal], 'skill_view', { name: literal.name }, 0, rendered).content, playbookMarkdown(literal))
    const inactive = { ...book, content: '${HERMES_SESSION_ID} ${HERMES_SKILL_DIR}/unavailable.py !`unused`' }
    fs.writeFileSync(path.join(profileDir(profile), 'config.yaml'), 'skills:\n  template_vars: false\n  inline_shell: false\n')
    state = open(team, { ...member, playbooks: [inactive] })
    assert.deepEqual(state.gaps, [])
    assert.equal(readPlaybookTool([inactive], 'skill_view', { name: book.name }, 0, state).content, playbookMarkdown(inactive))
    fs.writeFileSync(path.join(profileDir(profile), 'config.yaml'), 'skills:\n  inline_shell: true\n')
    assert.ok(open(team, { ...member, playbooks: [inactive] }).gaps.includes('playbook inline shell'))
    fs.mkdirSync(env.HERMES_MANAGED_DIR)
    fs.writeFileSync(path.join(env.HERMES_MANAGED_DIR, 'config.yaml'), 'skills:\n  inline_shell: off\n  template_vars: no\n')
    state = open(team, { ...member, playbooks: [inactive] })
    assert.deepEqual(state.gaps, [])
    assert.equal(readPlaybookTool([inactive], 'skill_view', { name: inactive.name }, 0, state).content, playbookMarkdown(inactive))
    fs.writeFileSync(path.join(env.HERMES_MANAGED_DIR, 'config.yaml'), 'skills:\n  inline_shell: on\n  template_vars: true\n')
    assert.ok(open(team, { ...member, playbooks: [inactive] }).gaps.includes('playbook inline shell'))
    fs.writeFileSync(path.join(env.HERMES_MANAGED_DIR, 'config.yaml'), 'skills:\n  inline_shell: ${HOST_FLAG}\n')
    assert.ok(open(team, { ...member, playbooks: [inactive] }).gaps.includes('unverified playbook file or configuration'))
    fs.unlinkSync(path.join(env.HERMES_MANAGED_DIR, 'config.yaml'))
    manifest(scoped)
    assert.deepEqual(open(team, { ...member, playbooks: [{ ...book, content: '[Read the guide](references/guide.md#start)' }] }).gaps, [])
    const display = open(team, { name: 'Product Research', playbooks: [{ ...book, content: '${HERMES_SESSION_ID}' }] })
    assert.deepEqual(display.gaps, [])
    assert.equal(display.sessionId, specialistSessionId(specialistProfileName(team.name, 'Product Research'), 'chat', 'turn'))
    const longName = 'A'.repeat(64),
        longRole = open({ ...team, name: longName }, { name: longName, playbooks: [{ ...book, content: '${HERMES_SESSION_ID}' }] })
    assert.deepEqual(longRole.gaps, [])
    assert.equal(longRole.sessionId, specialistSessionId(specialistProfileName(longName, longName), 'chat', 'turn'))
    manifest()
    for (const content of [
        '${HERMES_SKILL_DIR}/../somewhere',
        '${HERMES_SKILL_DIR}/scripts/command.sh',
        '${HERMES_SKILL_DIR}/assets/$name.txt',
        '${HERMES_SKILL_DIR}/references/missing.md',
        '[Read the guide](references/missing.md)',
        '[Read the guide][resource]\n\n[resource]: references/missing.md',
        'Read references/missing.md.',
        'You must read references/missing.md before calculating.',
        'You should first consult references/missing.md before publishing.',
        'Before publishing, consult references/missing.md.',
        'You are required to open `references/missing.md` before proceeding.',
        'Run `scripts/fixed.py` with supplied arguments.'
    ]) {
        assert.ok(open(team, { ...member, playbooks: [{ ...book, content }] }).gaps.includes('unverified playbook file dependency'))
    }
})

test('a saved native specialist receives its own admitted playbook turn identifier through normal delegation', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'saved-templates-'))
    const name = 'playbook-qa'
    for (const [key, value] of Object.entries({
        HOME: dir,
        CUTTLELY_HERMES_HOME: path.join(dir, 'runtime'),
        CUTTLELY_DATA_DIR: dir,
        DATABASE_PATH: dir,
        CUTTLELY_NATIVE_PRIME_TEAMS: name,
        CUTTLELY_HOST_FILE_MANIFEST: ''
    })) {
        const before = process.env[key]
        process.env[key] = value
        t.after(() => (before === undefined ? delete process.env[key] : (process.env[key] = before)))
    }
    const { rosterFromFlow } = await import('../sync-from-flow.mjs')
    const { getHarness, saveHarness } = await import('../store.mjs')
    const { runHarness } = await import('../run.mjs')
    const { closeSessions } = await import('../session.mjs')
    const { closeQueueDb } = await import('../lock.mjs')
    t.after(() => {
        closeSessions()
        closeQueueDb()
        fs.rmSync(dir, { recursive: true, force: true })
    })
    const canvas = JSON.parse(
        JSON.parse(fs.readFileSync(new URL('../../../samples/harnesses/calculator.canvas.json', import.meta.url))).flowData
    )
    canvas.nodes = canvas.nodes.filter((node) => node.data.name !== 'calculator')
    canvas.edges = canvas.edges.filter((edge) => edge.source !== 'calculator_0')
    const book = { name: 'record', description: 'QA', content: 'Turn = ${HERMES_SESSION_ID}\nGuide = ${HERMES_SKILL_DIR}/SKILL.md' }
    canvas.nodes.find((node) => node.data.name === 'harnessSpecialist').data.inputs.playbooks = [book]
    const workspaceId = 'qa-workspace'
    saveHarness(rosterFromFlow({ name, workspaceId, chatflowId: 'qa-flow', flowData: JSON.stringify(canvas) }))
    const calls = []
    let afterRead = () => {}
    class Model {
        async init() {
            return {
                invoke: assert.fail,
                bindTools(tools) {
                    const names = tools.map((tool) => tool.function.name)
                    return {
                        async invoke(messages) {
                            const last = messages.at(-1)
                            const call = (name, args) => ({ content: '', tool_calls: [{ name, args, id: 'fixture-' + calls.length }] })
                            if (names.includes('run_specialist'))
                                return last._getType() === 'tool'
                                    ? { content: last.content }
                                    : call('run_specialist', { name: 'math', task: 'Read the assigned playbook and its raw file.' })
                            if (last._getType() !== 'tool') {
                                calls.push('render')
                                return call('skill_view', { name: 'record' })
                            }
                            const out = JSON.parse(last.content)
                            assert.ok(out.success)
                            if (!out.file) {
                                calls.push('raw')
                                assert.match(out.content, /Turn = playbook-qa--math:qa-chat#turn-[^\s]+/)
                                assert.match(out.content, /Guide = \/skills\/harness-playbooks\/record\/SKILL\.md/)
                                return call('skill_view', { name: 'record', file_path: 'SKILL.md' })
                            }
                            assert.equal(out.content, playbookMarkdown(book))
                            await afterRead()
                            return { content: 'Verified assigned turn and guide.' }
                        }
                    }
                }
            }
        }
    }
    const run = (options = {}) =>
        runHarness({
            name,
            input: 'Check the assigned guide.',
            mode: 'agent',
            chatId: 'qa-chat',
            loadNode: async () => Model,
            flowOptions: { workspaceId, appDataSource: {}, harnessCaller: { via: 'session' } },
            ...options
        })
    const events = []
    const result = await run({ onEvent: (event) => events.push(event) })
    assert.ok(events.some((event) => event.type === 'partial' && event.text === 'Verified assigned turn and guide.'))
    assert.equal(result.trace.engine, 'native')
    assert.equal(result.agents[0].status, 'completed', result.agents[0].error)
    assert.equal(result.text, 'Verified assigned turn and guide.')
    assert.deepEqual(calls, ['render', 'raw'])

    // A provider completion can arrive after the revision changed or the caller cancelled.
    // Neither completion may release the fixture answer as a partial or final event.
    const controller = new AbortController()
    for (const action of ['cancel', 'change']) {
        events.length = 0
        let reached = false
        afterRead = () => {
            reached = true
            if (action === 'cancel') controller.abort()
            else {
                const record = getHarness(name)
                saveHarness({ ...record, chief: { ...record.chief, instructions: 'Updated fixture instructions.' } }, { overwrite: true })
            }
        }
        const pending = run({ onEvent: (event) => events.push(event), signal: action === 'cancel' ? controller.signal : undefined })
        if (action === 'change') await assert.rejects(pending, { code: 'harness_changed' })
        else await assert.rejects(pending)
        assert.ok(reached, 'The simulated model must read the fixture before the change or cancellation.')
        assert.ok(
            !events.some((event) => event.type === 'final' || (event.type === 'partial' && event.text.includes('Verified assigned turn')))
        )
    }
})

test('protected native model deltas preserve text while grouping public sends independently of token count', async (t) => {
    const { bufferStream } = await import('../run.mjs')
    let time = 1
    t.mock.method(performance, 'now', () => time)
    const guard = { checkPlaybookDelivery: () => {} }
    const sent = []
    const push = (text) => sent.push(text)
    bufferStream(guard, 'fixture', 'One. ', false, push)
    for (let n = 0; n < 100; n++) bufferStream(guard, 'fixture', 'word ', false, push)
    assert.equal(sent.length, 1)
    time += 251
    bufferStream(guard, 'fixture', 'Last. ', false, push)
    bufferStream(guard, 'fixture', '', true, push)
    assert.equal(sent.join(''), 'One. ' + 'word '.repeat(100) + 'Last. ')
    assert.ok(sent.length <= 3)
})
