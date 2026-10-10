import { nodeIconPath } from './nodeIcon'

describe('nodeIconPath', () => {
    it('returns a file for a real icon and nothing for an unknown node', () => {
        expect(nodeIconPath('/nodes/toolAgent.png')).toBe('/nodes/toolAgent.png')
        expect(nodeIconPath('/nodes/agent.svg')).toBe('/nodes/agent.svg')
        expect(nodeIconPath(undefined)).toBeUndefined()
        expect(nodeIconPath('not-a-file')).toBeUndefined()
    })
})
