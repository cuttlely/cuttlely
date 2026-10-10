// A saved flow opens zoomed to fit its cards. React Flow's fitView prop only fits the cards present when the canvas
// first mounts, and a saved flow's cards arrive later, so the canvas fits once the loaded cards have been measured.
export const FIT_ON_OPEN = { padding: 0.2, maxZoom: 1 }

export function readyToFit(nodes) {
    return Array.isArray(nodes) && nodes.length > 0 && nodes.every((node) => node?.width > 0 && node?.height > 0)
}
