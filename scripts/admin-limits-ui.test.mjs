import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const source = fs.readFileSync(new URL('../packages/ui/src/views/serversettings/model.js', import.meta.url), 'utf8')
const { describeValue, effectiveValues, numberWarning, reviewRows } = await import(
    `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
)

test('clearing a saved limit previews the host fallback in review, conditions and warnings', () => {
    const setting = {
        key: 'CUTTLELY_HARNESS_TURN_BUDGET_MS',
        label: 'Turn time limit',
        type: 'number',
        unit: 'ms-as-seconds',
        value: '90000',
        effective: '90000',
        defaultValue: '45000',
        defaultLabel: '45 seconds',
        clearValue: '0',
        clearSource: 'host',
        zeroLabel: 'Unlimited',
        warnings: { zero: 'Unlimited' }
    }
    const drafts = { [setting.key]: '' }
    assert.equal(describeValue(setting, ''), 'Host (Unlimited)')
    assert.equal(reviewRows([setting], drafts)[0].to, 'Host (Unlimited)')
    assert.equal(effectiveValues([setting], drafts).get(setting.key), '0')
    assert.deepEqual(numberWarning(setting, drafts), { strong: true, message: 'Unlimited' })
    const finite = { ...setting, clearValue: '60000', zeroLabel: 'Unlimited' }
    assert.equal(describeValue(finite, ''), 'Host (60 seconds)')
})

test('clearing without a host keeps the built-in default preview', () => {
    const setting = {
        key: 'limit',
        type: 'number',
        defaultValue: '45000',
        defaultLabel: '45 seconds',
        clearValue: '45000',
        clearSource: 'default'
    }
    assert.equal(describeValue(setting, ''), 'Default (45 seconds)')
    assert.equal(effectiveValues([setting], { limit: '' }).get('limit'), '45000')
})
