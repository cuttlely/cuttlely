import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_SAVE_PLACEHOLDER, saveFlowPlaceholder } from './saveFlowPlaceholder'

describe('saveFlowPlaceholder', () => {
    it('says harness on the harness canvas', () => {
        expect(saveFlowPlaceholder({ isHarnessCanvas: true })).toBe('My New Harness')
    })

    it('keeps the chatflow text everywhere else', () => {
        expect(saveFlowPlaceholder({ isHarnessCanvas: false })).toBe('My New Chatflow')
        expect(saveFlowPlaceholder()).toBe(DEFAULT_SAVE_PLACEHOLDER)
    })

    it('is what the canvas header hands the Save New dialog, and the dialog shows it', () => {
        const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
        expect(read('views/canvas/CanvasHeader.jsx')).toMatch(/placeholder: saveFlowPlaceholder\(\{ isHarnessCanvas \}\)/)
        const dialog = read('ui-component/dialog/SaveChatflowDialog.jsx')
        expect(dialog).toMatch(/placeholder=\{dialogProps\.placeholder \?\? DEFAULT_SAVE_PLACEHOLDER\}/)
        expect(dialog).not.toMatch(/placeholder='My New Chatflow'/)
    })

    it('starts the Save New box with the name a built flow arrived with', () => {
        const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
        expect(read('views/canvas/CanvasHeader.jsx')).toMatch(/defaultName: chatflow\?\.id \? '' : chatflow\?\.name \|\| ''/)
        expect(read('ui-component/dialog/SaveChatflowDialog.jsx')).toMatch(
            /if \(show\) setChatflowName\(dialogProps\?\.defaultName \|\| ''\)/
        )
    })
})
