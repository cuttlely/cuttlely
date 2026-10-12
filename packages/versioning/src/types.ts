export interface VersionedFlow {
    id: string
    name: string
    type?: string
    category?: string | null
    flowData: string
    workspaceId?: string
}
