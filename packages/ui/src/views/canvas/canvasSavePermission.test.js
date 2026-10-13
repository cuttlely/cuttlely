import fs from 'fs'
import path from 'path'
import {
    canCreateCanvas,
    canDiscardDraft,
    canDraftSave,
    canEditCanvasName,
    canPublishCanvas,
    canvasSaveButtonPermission
} from './canvasSavePermission'

describe('canvas save permission', () => {
    test('a create-only role does not see draft Save or Publish', () => {
        expect(canDraftSave(['chatflows:create'], false)).toBe(false)
        expect(canPublishCanvas(['chatflows:create'], false)).toBe(false)
        expect(canDiscardDraft(['chatflows:create'], false)).toBe(false)
        expect(canDraftSave(['agentflows:create'], true)).toBe(false)
        expect(canPublishCanvas(['agentflows:create'], true)).toBe(false)
        expect(canEditCanvasName(['chatflows:create'], false)).toBe(true)
        expect(canEditCanvasName(['agentflows:create'], true)).toBe(true)
    })

    test('an update-only role of the matching type can draft-save, publish, and discard', () => {
        expect(canDraftSave(['chatflows:view', 'chatflows:update'], false)).toBe(true)
        expect(canPublishCanvas(['chatflows:update'], false)).toBe(true)
        expect(canDiscardDraft(['chatflows:update'], false)).toBe(true)
        expect(canDraftSave(['agentflows:view', 'agentflows:update'], true)).toBe(true)
        expect(canPublishCanvas(['agentflows:update'], true)).toBe(true)
        expect(canDiscardDraft(['agentflows:update'], true)).toBe(true)
    })

    test("the other type's update key is denied", () => {
        expect(canDraftSave(['agentflows:update'], false)).toBe(false)
        expect(canPublishCanvas(['agentflows:update'], false)).toBe(false)
        expect(canDiscardDraft(['chatflows:update'], true)).toBe(false)
        expect(canPublishCanvas(['chatflows:update'], true)).toBe(false)
    })

    test('a view-only role does not see the banner buttons', () => {
        expect(canDiscardDraft(['chatflows:view'], false)).toBe(false)
        expect(canPublishCanvas(['chatflows:view'], false)).toBe(false)
        expect(canDiscardDraft(['agentflows:view'], true)).toBe(false)
        expect(canDraftSave(['agentflows:view'], true)).toBe(false)
    })

    test('a new unsaved flow with create can save, and update alone cannot', () => {
        expect(canvasSaveButtonPermission(false, { hasId: false, draftMode: true })).toBe('chatflows:create')
        expect(canvasSaveButtonPermission(true, { hasId: false })).toBe('agentflows:create')
        expect(canCreateCanvas(['chatflows:create'], false)).toBe(true)
        expect(canCreateCanvas(['chatflows:update'], false)).toBe(false)
        expect(canCreateCanvas(['agentflows:create'], true)).toBe(true)
        expect(canvasSaveButtonPermission(false, { hasId: true, draftMode: true })).toBe('chatflows:update')
        expect(canvasSaveButtonPermission(true, { hasId: true, draftMode: false })).toBe('agentflows:create,agentflows:update')
    })

    test('the header gates Publish, draft Save, and the banner on update, and Edit Name on create or update', () => {
        const source = fs.readFileSync(path.join(__dirname, 'CanvasHeader.jsx'), 'utf8')
        expect(source).toContain('const draftPermission = canvasUpdatePermission(isAgentCanvas)')
        expect(source).toContain('const namePermission = canvasNamePermission(isAgentCanvas)')
        expect(source).toContain('canvasSaveButtonPermission(isAgentCanvas,')
        expect(source).toContain('permission={namePermission}')
        expect(source).toContain('permission={draftPermission}')
        expect(source).toContain('permission={saveButtonPermission}')
        expect(source).toContain("data-testid='publish-button'")
        expect(source).toContain('Discard draft')
        expect(source).not.toContain('setSavePermission')
    })
})
