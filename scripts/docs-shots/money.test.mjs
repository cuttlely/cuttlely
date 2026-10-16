import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { costHit, maskTexts, moneyHit } from './money.mjs'

const keep = (values) => maskTexts(values, { keepAmounts: true })
const hide = (values) => maskTexts(values)
const joined = (result) => result.values.join('')

describe('docs screenshot money masking', () => {
    it('keeps refund, credit and other answer amounts in keep-amount frames', () => {
        const values = ['Refund the $9.95 shipping and give a $55.80 store credit.', ' A $10.00 goodwill credit, estimated $279.00 value.']
        const result = keep(values)
        assert.deepEqual(result.values, values)
        assert.deepEqual(result.leftovers, [])
        assert.equal(costHit(joined(result)), null)
    })

    it('removes an Estimated cost sentence in the same element', () => {
        const result = keep(['Tokens 44. Estimated cost: Live estimated $0.0012, draft no price. Done.'])
        assert.equal(joined(result), 'Tokens 44. Done.')
        assert.equal(costHit(joined(result)), null)
    })

    it('removes a label and its amount split across elements', () => {
        for (const amount of ['$0.0123', ' ≈ $0.0012', '~$0.01', 'about $0.02']) {
            const result = keep(['Refund $9.95', 'Estimated cost:', amount, 'Credit $55.80'])
            assert.equal(joined(result), 'Refund $9.95Credit $55.80', amount)
            assert.deepEqual(result.leftovers, [], amount)
        }
    })

    it('removes an amount after a lead-in element', () => {
        const result = keep(['Estimated cost', '≈', '$0.0012', ' tokens 44'])
        assert.equal(joined(result), ' tokens 44')
        assert.deepEqual(result.leftovers, [])
    })

    it('reports an amount left behind after a removed label', () => {
        assert.deepEqual(keep(['Estimated cost:', '$0.01 to $0.02']).leftovers, ['to $0.02'])
        assert.deepEqual(keep(['Estimated cost', 'Live estimated $0.0012, draft no price.']).leftovers, [
            'Live estimated $0.0012, draft no price'
        ])
    })

    it('does not open a label on the bare word estimated', () => {
        const result = keep(['Estimated delivery:', '$279.00 value'])
        assert.equal(joined(result), 'Estimated delivery:$279.00 value')
        assert.deepEqual(result.leftovers, [])
    })

    it('removes every amount and the estimated caption in other frames', () => {
        const result = hide(['44 tokens, 0.7 s, estimated $0.0012', ' Refund $9.95'])
        assert.equal(moneyHit(joined(result)), null)
        assert.equal(joined(result), '44 tokens, 0.7 s Refund ')
    })

    it('flags a visible Estimated cost label, even split across elements', () => {
        assert.ok(costHit('Estimated\ncost\n$0.02'))
        assert.ok(costHit('estimated cost'))
        assert.equal(costHit('estimated $279.00 value'), null)
    })
})
