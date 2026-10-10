import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GAP, respace } from './templates-respace.mjs'

const node = (id, x, y, extra = {}) => ({ id, position: { x, y }, positionAbsolute: { x, y }, ...extra })

test('a covered card moves below the card it overlaps, and the saved size becomes the drawn size', () => {
    const { nodes, moved } = respace([node('a', 0, 0), node('b', 100, 300)], { a: { w: 300, h: 500 }, b: { w: 300, h: 200 } })
    assert.deepEqual(moved, [{ id: 'b', dy: 500 + GAP - 300 }])
    assert.equal(nodes[1].position.y, 500 + GAP)
    assert.equal(nodes[1].positionAbsolute.y, 500 + GAP)
    assert.deepEqual([nodes[0].width, nodes[0].height], [300, 500])
})

test('a card pushed down pushes the card under it too', () => {
    const { moved } = respace([node('a', 0, 0), node('b', 0, 300), node('c', 0, 600)], {
        a: { w: 300, h: 500 },
        b: { w: 300, h: 400 },
        c: { w: 300, h: 100 }
    })
    assert.deepEqual(
        moved.map((m) => m.id),
        ['b', 'c']
    )
})

test('cards side by side, or in different blocks, stay put', () => {
    const sizes = { a: { w: 300, h: 500 }, b: { w: 300, h: 500 }, c: { w: 300, h: 500 } }
    const { moved } = respace([node('a', 0, 0), node('b', 340, 0), node('c', 0, 100, { parentNode: 'block_0' })], sizes)
    assert.deepEqual(moved, [])
})

test('cards the gallery did not measure are left as they are', () => {
    const input = [node('a', 0, 0), node('b', 0, 10)]
    const { nodes, moved } = respace(input, { a: { w: 300, h: 500 } })
    assert.deepEqual(moved, [])
    assert.equal(nodes[1], input[1])
})
