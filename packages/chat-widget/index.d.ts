export const ELEMENT_NAME: 'cuttlely-chat'

export type ChatMode = 'bubble' | 'page'
export type ChatTheme = 'auto' | 'light' | 'dark'

export interface MountOptions {
    flowId: string
    apiHost?: string
    mode?: ChatMode
    theme?: ChatTheme
    open?: boolean
    config?: Record<string, unknown>
    overrideConfig?: Record<string, unknown>
    blocked?: 'private' | 'missing' | 'origin'
    storage?: Storage
}

export interface ChatController {
    open(): void
    close(returnFocus?: boolean): void
    reset(): void
    destroy(): void
    setTheme(theme: string): void
}

/** Renders a chat into `target`. `flowId` is the chatflow or agentflow id. */
export function mount(target: HTMLElement, options: MountOptions): ChatController

/** Defines the `<cuttlely-chat>` element. `defaultHost` is the Cuttlely server used when `api-host` is omitted. */
export function defineElement(defaultHost?: string): void

export class ChatWidget implements ChatController {
    constructor(target: HTMLElement, options: MountOptions)
    open(): void
    close(returnFocus?: boolean): void
    reset(): void
    destroy(): void
    setTheme(theme: string): void
}

export function renderMarkdown(source: string, options?: { base?: string }): string
export function escapeHtml(value: unknown): string
export function safeUrl(raw: unknown, options?: { image?: boolean; base?: string }): string
export function normalizeConfig(raw: unknown, overrides?: Record<string, unknown>): Record<string, unknown>
