import { ICommonObject } from './Interface'

export interface INestedFlowRequest {
    targetFlowId: string
    question: string
    chatId?: string
    overrideConfig?: ICommonObject
}

export type RunNestedFlow = (request: INestedFlowRequest) => Promise<ICommonObject>

/** Treat harmless URL spelling differences as local, but never equate different hosts, ports, or paths. */
export function isSameServerBaseURL(resolved: string, parent: string): boolean {
    try {
        const canonical = (value: string) => {
            const url = new URL(value)
            url.hash = ''
            url.search = ''
            url.pathname = url.pathname.replace(/\/+$/, '') || '/'
            return url.href
        }
        return canonical(resolved) === canonical(parent)
    } catch {
        return false
    }
}
