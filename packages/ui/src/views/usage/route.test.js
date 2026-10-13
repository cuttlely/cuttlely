import fs from 'fs'
import path from 'path'

describe('usage route', () => {
    it('gates /usage with the same view permission as the usage API', () => {
        const routes = fs.readFileSync(path.join(__dirname, '../../routes/MainRoutes.jsx'), 'utf8')
        const menu = fs.readFileSync(path.join(__dirname, '../../menu-items/dashboard.js'), 'utf8')
        const routeAt = routes.indexOf("path: '/usage'")
        expect(routeAt).toBeGreaterThan(-1)
        expect(routes.slice(routeAt, routeAt + 400)).toContain("permission={'chatflows:view,agentflows:view'}")
        const menuAt = menu.indexOf("url: '/usage'")
        expect(menuAt).toBeGreaterThan(-1)
        expect(menu.slice(menuAt, menuAt + 400)).toContain("permission: 'chatflows:view,agentflows:view'")
        expect(menu.slice(Math.max(0, menuAt - 250), menuAt)).toContain("id: 'usage'")
    })
})
