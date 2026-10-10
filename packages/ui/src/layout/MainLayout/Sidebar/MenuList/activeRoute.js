// Which sidebar item the current address belongs to. The address decides, not the last item clicked, so the right
// item stays marked after a reload, a link from another page, or the back button.

const matches = (base, pathname) => Boolean(base) && base !== '/' && (pathname === base || pathname.startsWith(`${base}/`))

// An item is active on its own address and on the pages under it, plus any extra addresses it lists in activeRoutes.
export const isItemActive = (item, pathname) => {
    if (!item || !pathname) return false
    return [item.url, ...(item.activeRoutes || [])].some((base) => matches(base, pathname))
}

// A group (like Admin) contains the current page when one of its items is active.
export const isGroupActive = (group, pathname) =>
    (group?.children || []).some((child) => (child.type === 'collapse' ? isGroupActive(child, pathname) : isItemActive(child, pathname)))
