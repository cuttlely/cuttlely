import { duplicateCanvasPath, newCanvasType } from './canvasKind'

// Mirrors how views/canvas/index.jsx reads the canvas kind from the route.
const kindFromPath = (path) => {
    const parts = path.split('/')
    return {
        isAgentCanvas: parts.includes('agentcanvas'),
        isHarnessCanvas: parts.includes('harnesscanvas'),
        isEtlCanvas: parts.includes('etlcanvas')
    }
}

describe('duplicating a harness', () => {
    it('opens the copy in the harness canvas, so it saves as a harness and is listed under Harnesses', () => {
        const source = { name: 'Sample Harness', type: 'HARNESS' }
        const path = duplicateCanvasPath({ isHarnessCanvas: true, isAgentCanvas: false, isEtlCanvas: false, isAgentflowV2: false })
        expect(path).toBe('/harnesscanvas')
        expect(newCanvasType(kindFromPath(path))).toBe(source.type)
    })
})
