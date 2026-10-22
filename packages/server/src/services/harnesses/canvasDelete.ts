// The chat flow service registers its delete here when it loads. A separate module with no imports, so the chat flow
// service and the harness service do not import each other.
export const harnessCanvasDelete: { run: ((chatflowId: string, workspaceId: string) => Promise<unknown>) | null } = { run: null }
