import dashboard from '@/menu-items/dashboard'
import { isGroupActive, isItemActive, menuItemAllowed } from './activeRoute'

const items = (group) => (group.children || []).flatMap((child) => (child.children ? items(child) : [child]))
const allItems = items(dashboard).filter((item) => item.type === 'item' && item.url)
const activeOn = (pathname) => allItems.filter((item) => isItemActive(item, pathname)).map((item) => item.id)
const groups = (group) => (group.children || []).flatMap((child) => (child.children ? [child, ...groups(child)] : []))
const admin = groups(dashboard).find((group) => group.type === 'collapse')

describe('Sidebar active item', () => {
    it('marks only Server Settings on the Server settings page, whatever was clicked before', () => {
        expect(activeOn('/server-settings')).toEqual(['serverSettings'])
        expect(isGroupActive(admin, '/server-settings')).toBe(true)
    })

    it('marks Version History on its page even though its id is not its address', () => {
        expect(activeOn('/version-history')).toEqual(['versionHistory'])
    })

    it('marks exactly one item on every page that has one, including the pages under it', () => {
        expect(activeOn('/agentflows')).toEqual(['agentflows'])
        expect(activeOn('/chatflows')).toEqual(['chatflows'])
        expect(activeOn('/document-stores/vector/store-1/doc-2')).toEqual(['document-stores'])
        expect(activeOn('/datasets')).toEqual(['datasets'])
        expect(activeOn('/dataset_rows/ds-1')).toEqual(['datasets'])
        expect(activeOn('/evaluators')).toEqual(['evaluators'])
        expect(activeOn('/evaluations')).toEqual(['evaluations'])
        expect(activeOn('/evaluation_results/ev-1')).toEqual(['evaluations'])
        expect(activeOn('/assistants/custom/abc')).toEqual(['assistants'])
        expect(activeOn('/harnesses/support-team')).toEqual(['harnesses'])
        expect(activeOn('/workspace-users/team-1')).toEqual(['workspaces'])
        expect(activeOn('/users')).toEqual(['users'])
        expect(activeOn('/usage')).toEqual(['usage'])
        expect(activeOn('/logs')).toEqual(['serverLogs'])
        expect(activeOn('/audit')).toEqual(['auditLog'])
        expect(isGroupActive(admin, '/logs')).toBe(true)
        expect(isGroupActive(admin, '/agentflows')).toBe(false)
    })

    it('does not match an address that only starts with the same letters', () => {
        expect(isItemActive({ url: '/tools' }, '/toolsets')).toBe(false)
        expect(isItemActive({ url: '/users' }, '/users-old')).toBe(false)
    })

    it('hides Datasets, Evaluators, and Evaluations when the role lacks those view permissions', () => {
        const shown = (permissions) => allItems.filter((item) => menuItemAllowed(item, permissions, false)).map((item) => item.id)
        expect(shown(['chatflows:view'])).not.toEqual(expect.arrayContaining(['datasets', 'evaluators', 'evaluations']))
        expect(shown(['datasets:view'])).toContain('datasets')
        expect(shown(['datasets:view'])).not.toContain('evaluators')
        expect(shown(['datasets:view'])).not.toContain('evaluations')
        expect(shown([])).not.toEqual(expect.arrayContaining(['datasets', 'evaluators', 'evaluations']))
        expect(menuItemAllowed({ permission: 'datasets:view' }, [], true)).toBe(true)
    })

    it('hides Usage unless the role can view chatflows or agentflows', () => {
        const shown = (permissions) => allItems.filter((item) => menuItemAllowed(item, permissions, false)).map((item) => item.id)
        expect(shown(['tools:view'])).not.toContain('usage')
        expect(shown([])).not.toContain('usage')
        expect(shown(['chatflows:view'])).toContain('usage')
        expect(shown(['agentflows:view'])).toContain('usage')
        expect(menuItemAllowed({ permission: 'chatflows:view,agentflows:view' }, [], true)).toBe(true)
    })

    it('marks nothing on a page with no sidebar item, and never matches the root address', () => {
        expect(activeOn('/promote/1')).toEqual([])
        expect(isItemActive({ url: '/' }, '/agentflows')).toBe(false)
        expect(isItemActive({ url: '' }, '/agentflows')).toBe(false)
    })
})
