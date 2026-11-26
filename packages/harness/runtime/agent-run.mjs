// The caller owns the turn and its trace. The engine owns a single execution within it.
import { createRun, hermesRunFinished, stopRun, waitForRun } from '../client.mjs'

const hermes = { start: createRun, wait: waitForRun, stop: stopRun }

export async function executeAgentRun(
    { request, body, deadlineAt, capacityWaitSeconds, onCapacityWait, onEvent, onUnconfirmedStop },
    engine = hermes
) {
    const { signal } = request
    let runId
    let finished = false
    let stopping
    const stop = () => {
        if (!runId || finished || stopping) return
        // The admission response can race an abort. Once the ID is known, cancel only that run,
        // using a fresh deadline so the aborted turn signal cannot interrupt cleanup.
        stopping = Promise.resolve()
            .then(() => engine.stop({ ...request, runId, signal: undefined, timeoutMs: 2000 }))
            .then((confirmed) => {
                if (!confirmed) onUnconfirmedStop?.()
            })
            .catch(() => {})
    }
    signal?.throwIfAborted()
    signal?.addEventListener('abort', stop, { once: true })
    try {
        const created = await engine.start({ ...request, body, capacityWaitSeconds, onCapacityWait })
        runId = created.run_id
        signal?.throwIfAborted()
        const status =
            created.output || created.error || hermesRunFinished(created.status) || !runId
                ? created
                : await engine.wait({
                      ...request,
                      runId,
                      onEvent,
                      timeoutMs: deadlineAt ? Math.max(1, deadlineAt - Date.now()) : request.timeoutMs
                  })
        finished = hermesRunFinished(status.status) || (!status.status && typeof status.output === 'string')
        signal?.throwIfAborted()
        return status
    } catch (error) {
        stop()
        throw error
    } finally {
        signal?.removeEventListener('abort', stop)
        await stopping
    }
}
