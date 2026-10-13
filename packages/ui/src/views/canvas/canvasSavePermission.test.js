import fs from 'fs'
import path from 'path'
import { AGENTFLOW_CANVAS_SAVE, CHATFLOW_CANVAS_SAVE, canSaveCanvas, canvasSavePermission } from './canvasSavePermission'

describe('canvas save permission', () => {
    test('an update-only role sees Save and Publish on an existing chat, harness, or ETL canvas', () => {
        const granted = ['chatflows:view', 'chatflows:update']
        expect(canvasSavePermission(false)).toBe(CHATFLOW_CANVAS_SAVE)
        expect(canSaveCanvas(granted, false)).toBe(true)
    })

    test('a view-only role does not see Save or Publish', () => {
        expect(canSaveCanvas(['chatflows:view'], false)).toBe(false)
        expect(canSaveCanvas(['agentflows:view'], true)).toBe(false)
    })

    test('an update-only role sees Save and Publish on an existing agentflow canvas, and a chatflow update does not', () => {
        expect(canvasSavePermission(true)).toBe(AGENTFLOW_CANVAS_SAVE)
        expect(canSaveCanvas(['agentflows:view', 'agentflows:update'], true)).toBe(true)
        expect(canSaveCanvas(['chatflows:view', 'chatflows:update'], true)).toBe(false)
        expect(canSaveCanvas(['agentflows:view', 'agentflows:update'], false)).toBe(false)
    })

    test('a create-only role still sees Save and Publish', () => {
        expect(canSaveCanvas(['chatflows:create'], false)).toBe(true)
        expect(canSaveCanvas(['agentflows:create'], true)).toBe(true)
    })

    test('the header uses that any-of string for Save, Publish, and Edit Name on a new canvas and an existing one', () => {
        const source = fs.readFileSync(path.join(__dirname, 'CanvasHeader.jsx'), 'utf8')
        expect(source).toContain('const savePermission = canvasSavePermission(isAgentCanvas)')
        expect(source).not.toContain('setSavePermission')
        expect(source.match(/permission=\{savePermission\}/g)).toHaveLength(3)
        expect(source).toContain("data-testid='publish-button'")
        expect(source).toContain('title={`Save ${title}`}')
    })
})
