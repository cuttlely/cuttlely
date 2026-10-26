export function assertHarnessWorkspace() {}
export function configureHarnessRuntime() {}
export function warmHarnessProfiles() {}
export async function runHarness(opts) {
    if (typeof opts.onRecorded === 'function') opts.onRecorded({ id: 'run_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', chatId: opts.chatId })
    return { text: 'baked' }
}
export async function runQueuedHarness(opts) {
    const external = process.env.CUTTLELY_HARNESS_QUEUE === 'external'
    const fail = process.env.CUTTLELY_HARNESS_STUB_FAIL === '1'
    if (!external && typeof opts.onRecorded === 'function') {
        opts.onRecorded({ id: 'run_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', chatId: opts.chatId })
    }
    if (fail) {
        const error = new Error('oven failed')
        if (external) error.runId = 'run_cccccccc-cccc-4ccc-8ccc-cccccccccccc'
        throw error
    }
    if (external) return { text: 'baked', runId: 'run_cccccccc-cccc-4ccc-8ccc-cccccccccccc' }
    return { text: 'baked', runId: 'run_cccccccc-cccc-4ccc-8ccc-cccccccccccc' }
}
