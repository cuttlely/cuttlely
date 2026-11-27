const assert = require('node:assert/strict'),
    Module = require('node:module'),
    original = Module._load
const text = (s) => ({ content: s, usage_metadata: { input_tokens: 4, output_tokens: 3 } })
const payload = ['read_file', 'write_file', 'patch', 'search_files']
const call = (name, args, step) => ({ ...text('step ' + step), tool_calls: [{ name, args, id: 'q' + step }] })
Module._load = function (request, parent) {
    const lib = original.apply(this, arguments)
    if (request !== './FlowiseChatXAI' || !parent?.filename.endsWith('/ChatXAI/ChatXAI.js')) return lib
    return {
        ...lib,
        ChatXAI: class extends lib.ChatXAI {
            constructor(id, fields) {
                assert.equal(fields.apiKey, process.env.KRAKEN_OPS_MODEL_KEY)
                super(id, fields)
            }
            bindTools(tools) {
                const names = tools.map((x) => x.function?.name || x.name)
                return {
                    invoke: async (messages) => {
                        const last = messages.at(-1),
                            after = last._getType() === 'tool',
                            prompt = messages.map((m) => m.content).join('\n')
                        if (names.includes('run_specialist'))
                            return after
                                ? text(last.content)
                                : call(
                                      'run_specialist',
                                      {
                                          name: 'math',
                                          task: messages.at(-1).content.includes('CATALOG_SCOPE')
                                              ? 'CATALOG_SCOPE'
                                              : prompt.includes('PROBE')
                                              ? 'PROBE isolation.'
                                              : prompt.includes('RECOVER')
                                              ? 'RECOVER stored result.'
                                              : 'WRITE file and calculate report.'
                                      },
                                      'prime'
                                  )
                        assert.deepEqual([...names].sort(), [...payload].sort())
                        const previous = after ? Number(messages.at(-2).content.split(' ').at(-1)) : 0
                        const result = after ? JSON.parse(last.content) : {}
                        if (prompt.includes('CATALOG_SCOPE')) {
                            if (!after) return call('read_file', { path: 'uploads/catalog.csv', limit: 2 }, 1)
                            return text(result.content?.includes('sample,19') ? 'Owned upload displayed.' : 'Scoped upload unavailable.')
                        }
                        if (prompt.includes('PROBE isolation.')) {
                            if (!after) return call('read_file', { path: 'scores.txt' }, 1)
                            assert.ok(result.error && !result.content, 'Other caller read this workspace.')
                            return text('Scoped file unavailable.')
                        }
                        if (prompt.includes('RECOVER')) {
                            if (!after) return call('read_file', { path: 'scores.txt' }, 1)
                            assert.match(result.content, /score=19/)
                            return text('Recovered 19.')
                        }
                        const steps = [
                            ['write_file', { path: 'scores.txt', content: 'score=10\n' }],
                            ['read_file', { path: 'scores.txt' }],
                            ['patch', { path: 'scores.txt', old_string: 'score=10', new_string: 'score=19' }],
                            ['search_files', { pattern: 'score=1[0-9]', path: 'scores.txt' }],
                            [
                                'patch',
                                {
                                    mode: 'patch',
                                    patch: '*** Begin Patch\n*** Add File: output/summary.csv\n+result,value\n+score,19\n*** End Patch'
                                }
                            ]
                        ]
                        if (after) {
                            assert.ok(!result.error, result.error)
                            if (previous === 4) assert.equal(result.matches[0].content, 'score=19')
                        }
                        if (previous >= steps.length) return text('Synthetic receipt 19.')
                        return call(...steps[previous], previous + 1)
                    }
                }
            }
            async invoke(messages) {
                const system = String(messages[0]?.content || ''),
                    body = messages.map((m) => m.content).join('\n')
                if (system.startsWith('You name chat sessions.')) return text('File QA')
                if (system.includes('steps') && !body.includes('Synthetic receipt 19.') && !body.includes('Recovered 19.'))
                    return text(
                        JSON.stringify({
                            steps: [
                                {
                                    specialist: 'math',
                                    task: body.includes('RECOVER') ? 'RECOVER stored result.' : 'WRITE file and calculate report.'
                                }
                            ]
                        })
                    )
                if (body.includes('Recovered 19.')) return text('Recovered 19.')
                if (body.includes('Synthetic receipt 19.')) return text('Synthetic receipt 19.')
                return text(JSON.stringify({ steps: [{ specialist: 'math', task: 'WRITE file and calculate report.' }] }))
            }
            async *stream(messages) {
                yield await this.invoke(messages)
            }
        }
    }
}
