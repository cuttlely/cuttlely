import fs from 'fs'
import path from 'path'
import { reservedHarnessNameMessage } from './harnessName'

describe('reserved harness names', () => {
    it('rejects a name that matches a draft try profile and leaves ordinary names alone', () => {
        const reserved = `try${'a'.repeat(16)}`
        expect(reservedHarnessNameMessage(reserved)).toBe(
            `Harness name "${reserved}" is reserved for a draft try. Choose a different name.`
        )
        expect(reservedHarnessNameMessage(`Try${'AB'.repeat(8)}`)).toContain('reserved for a draft try')
        expect(reservedHarnessNameMessage('tryabcdef')).toBe('')
        expect(reservedHarnessNameMessage('chief-of-staff')).toBe('')
    })

    it('shows that message in the save dialog and the canvas name field', () => {
        const dialog = fs.readFileSync(path.join(__dirname, '../ui-component/dialog/SaveChatflowDialog.jsx'), 'utf8')
        const header = fs.readFileSync(path.join(__dirname, '../views/canvas/CanvasHeader.jsx'), 'utf8')
        const canvas = fs.readFileSync(path.join(__dirname, '../views/canvas/index.jsx'), 'utf8')
        expect(dialog).toContain('nameError')
        expect(dialog).toContain('harness-name-error')
        expect(header).toContain('reservedHarnessNameMessage')
        expect(header).toContain('nameError: isHarnessCanvas ? reservedHarnessNameMessage : undefined')
        expect(canvas).toContain('reservedHarnessNameMessage(importedName)')
    })
})
