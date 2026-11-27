import { randomUUID } from 'node:crypto'

// The queue installs this callback in-process after it authenticates the admitted job.
export const nativeToolJournal = Symbol('native tool journal')

export function queueNativeTool(context, specialist, name) {
    const id = randomUUID()
    const journal = context.nativeSpecialists && context.moduleOptions.flowOptions[nativeToolJournal]
    const write = (phase) => journal?.({ callId: id, specialist: specialist.name, name, phase })
    write('queued')
    return {
        id,
        async invoke(operation) {
            context.assertNativeAuthority()
            write('dispatched')
            const result = await operation()
            write('confirmed')
            return result
        }
    }
}
