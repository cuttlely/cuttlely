// The canvas kind follows the route: /harnesscanvas, /etlcanvas, /agentcanvas, /v2/agentcanvas or /canvas.

// The type a canvas saves as the first time, from the kind of canvas it is open in.
export function newCanvasType({ isEtlCanvas, isHarnessCanvas, isAgentCanvas } = {}) {
    if (isEtlCanvas) return 'ETL'
    if (isHarnessCanvas) return 'HARNESS'
    if (isAgentCanvas) return 'MULTIAGENT'
    return 'CHATFLOW'
}

// The route that opens a copy in the same kind of canvas, so the copy saves with the source type.
export function duplicateCanvasPath({ isEtlCanvas, isHarnessCanvas, isAgentflowV2, isAgentCanvas } = {}) {
    if (isHarnessCanvas) return '/harnesscanvas'
    if (isEtlCanvas) return '/etlcanvas'
    if (isAgentflowV2) return '/v2/agentcanvas'
    if (isAgentCanvas) return '/agentcanvas'
    return '/canvas'
}
