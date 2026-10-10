import { Request } from 'express'

/**
 * The one rule for whether a request asked for an event stream: boolean `true`, or the string `'true'`
 * (multipart form fields always arrive as strings). Anything else (`1`, `'1'`, `'TRUE'`, `{}`, `'false'`, ...)
 * is a normal JSON request. The prediction controller, `authorizeFlowAccess` and `checkIfStreamValid` all use
 * this, so a request is either answered as a stream everywhere or as JSON everywhere.
 */
export const isStreamingValue = (value: unknown): boolean => value === true || value === 'true'

/** `isStreamingValue` applied to `req.body.streaming`; false when there is no body. */
export const isStreamingRequest = (req: Request): boolean => isStreamingValue(req.body?.streaming)

type StreamNode = { category?: string; name?: string; data?: { category?: string } | null }

/**
 * A chatflow whose ending node is the Harness tool can stream even though its chat models
 * live on the harness canvas. `null` means this is not that node, so the chain and agent rules still decide.
 */
export const harnessEndingNodeStreams = (
    endingNode: StreamNode | null | undefined,
    nodes: StreamNode[] | null | undefined
): boolean | null => {
    if (endingNode?.category !== 'Harness' || endingNode?.name !== 'harness') return null
    const blocked = (nodes || []).some((flowNode) => String(flowNode?.data?.category || flowNode?.category || '').includes('Output Parser'))
    return !blocked
}
