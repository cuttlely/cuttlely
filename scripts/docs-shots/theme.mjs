// The UI reads localStorage.isDarkMode once at load, so a canvas reached by in-app navigation
// (Use Template, Build with AI) keeps the theme it loaded with. setAppTheme dispatches the action the
// header toggle sends, without a reload. It leaves localStorage alone: the header switch takes its
// position from that key at load, and a later page should load in the light theme.
//
// DOCS_SHOTS_CANVAS_THEME=light keeps canvas frames in the light theme. The default is dark.
export const CANVAS_DARK = (process.env.DOCS_SHOTS_CANVAS_THEME || 'dark') !== 'light'

export async function setAppTheme(page, dark) {
    await page.evaluate((value) => {
        const root = document.getElementById('root')
        const key = root && Object.keys(root).find((name) => name.startsWith('__reactContainer$'))
        const stack = key ? [root[key]] : []
        while (stack.length) {
            const fiber = stack.pop()
            if (!fiber) continue
            const store = fiber.memoizedProps?.store
            if (store?.dispatch && store?.getState) {
                if (store.getState().customization?.isDarkMode !== value) {
                    store.dispatch({ type: '@customization/SET_DARKMODE', isDarkMode: value })
                }
                return
            }
            stack.push(fiber.sibling, fiber.child)
        }
    }, dark)
    await page.waitForTimeout(250)
}

export async function themeFor(page, dark) {
    await setAppTheme(page, CANVAS_DARK && dark)
}
