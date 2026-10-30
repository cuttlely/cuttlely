import assert from 'node:assert/strict'
import test from 'node:test'
import { sourceAnswerFallback } from './source-answer-fallback.mjs'

test('unsafe generated prose falls back to escaped business fields without private metadata', () => {
    const text = sourceAnswerFallback([
        {
            result: {
                rows: [
                    {
                        account_name: 'Example | [Co](x)',
                        amount: '8.20',
                        currency: null,
                        notes: '<script>bad</script>',
                        access_token: 'private-fixture-token',
                        password: 'private-fixture-password',
                        sql: 'private SQL'
                    }
                ]
            }
        }
    ])
    assert.match(text, /8\.20/)
    assert.match(text, /Unavailable &#40;NULL&#41;/)
    assert.ok(text.includes('&#91;Co&#93;&#40;x&#41;'))
    assert.ok(text.includes('&lt;script&gt;'))
    assert.ok(!text.includes('private-fixture'))
    assert.ok(!text.includes('private SQL'))
})

test('source field fallback is capped and distinguishes an executed empty query from missing display fields', () => {
    const rows = Array.from({ length: 120 }, (_, index) => ({ amount: String(index) }))
    const text = sourceAnswerFallback([{ result: { rows } }])
    assert.equal(text.split('\n').filter((line) => line.startsWith('| Record')).length, 100)
    assert.match(text, /bounded display/)
    assert.match(sourceAnswerFallback([{ result: { rows: [] } }]), /query returned no rows/)
})
