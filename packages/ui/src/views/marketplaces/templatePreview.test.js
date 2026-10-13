import fs from 'fs'
import path from 'path'

import { cardsAfterPreviewKey, templatePreviewProps } from './templatePreview'

const previewFiles = [path.join(__dirname, 'MarketplaceCanvas.jsx'), path.join(__dirname, '../agentflowsv2/MarketplaceCanvas.jsx')]

describe('template preview keyboard', () => {
    const cards = [
        { id: 'promptTemplate_0', selected: true },
        { id: 'chatOpenAI_0', selected: true }
    ]

    test('Backspace and Delete leave every card', () => {
        expect(templatePreviewProps).toEqual({ deleteKeyCode: null, elementsSelectable: false })
        expect(cardsAfterPreviewKey(cards, 'Delete')).toEqual(cards)
        expect(cardsAfterPreviewKey(cards, 'Backspace')).toEqual(cards)
        expect(cardsAfterPreviewKey(cards, 'Delete', { deleteKeyCode: ['Delete'], elementsSelectable: true })).toEqual([])
    })

    test('both template previews pass those props to the canvas', () => {
        for (const file of previewFiles) {
            const source = fs.readFileSync(file, 'utf8')
            expect(source).toContain('templatePreviewProps')
            expect(source).toContain('{...templatePreviewProps}')
        }
    })
})
