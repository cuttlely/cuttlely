// A prediction creates a new runNestedFlow capability for its admitted caller.
// Keep its file grants outside generic node options, saved executions and traces.
export type ManagedPredictionUpload = { name: string; mime: string; rows: number | null; proof: string; path?: string }
type Resolve = (harness: string) => Promise<ManagedPredictionUpload[]>
const requests = new WeakMap<object, Resolve>()

export function registerManagedPredictionUploads(runNestedFlow: object, resolve: Resolve): void {
    requests.set(runNestedFlow, resolve)
}

export function admittedManagedUploads(runNestedFlow: unknown, harness: string): Promise<ManagedPredictionUpload[]> | undefined {
    return typeof runNestedFlow === 'function' ? requests.get(runNestedFlow)?.(harness) : undefined
}
