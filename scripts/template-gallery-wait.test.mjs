import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canvasSettled, previewProblems, sameCards } from './live-e2e/gallery-wait.mjs'

const look = (ids, connections = 1, size = 100) => ({ ids, connections, size })

test('cards match only when the screen shows exactly this canvas', () => {
    assert.equal(sameCards(['a', 'b'], ['b', 'a']), true)
    assert.equal(sameCards(['a'], ['a', 'b']), false)
    assert.equal(sameCards(['a', 'b', 'c'], ['a', 'b']), false)
    assert.equal(sameCards([], []), true)
})

test('a leftover card from the previous preview never counts as settled', () => {
    const previous = look(['chatOpenAI_0', 'promptTemplate_0'])
    assert.equal(canvasSettled([previous, previous, previous], ['chatOpenAI_0', 'llmChain_0']), false)
})

test('the canvas must hold still for the last three looks', () => {
    const expected = ['a', 'b']
    assert.equal(canvasSettled([look(expected), look(expected)], expected), false)
    assert.equal(canvasSettled([look(expected, 0), look(expected, 1), look(expected, 1)], expected), false)
    assert.equal(canvasSettled([look(expected, 1, 90), look(expected, 1, 100), look(expected, 1, 100)], expected), false)
    assert.equal(canvasSettled([look(['a']), look(expected), look(expected), look(expected)], expected), true)
})

test('a canvas that never held still does not pass, even with every card and connection drawn', () => {
    const expected = { cards: 2, connections: 1 }
    const seen = { cards: 2, connections: 1, empty: [], covered: [] }
    assert.deepEqual(previewProblems({ expected, seen, settled: true }), [])
    assert.deepEqual(previewProblems({ expected, seen, settled: false }), ['the canvas never held still'])
    assert.deepEqual(previewProblems({ expected, seen: { ...seen, cards: 1, covered: ['a / b'] }, settled: true }), [
        '1 of 2 cards drawn',
        'cards cover each other: a / b'
    ])
})
