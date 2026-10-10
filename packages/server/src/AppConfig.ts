export const appConfig = {
    showCommunityNodes: process.env.SHOW_COMMUNITY_NODES ? process.env.SHOW_COMMUNITY_NODES.toLowerCase() === 'true' : false
    // Settings an admin can change from the UI are listed in settings/registry.ts (Server settings).
}
