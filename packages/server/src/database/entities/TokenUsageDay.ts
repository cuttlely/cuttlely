import { Column, Entity, Index, PrimaryColumn } from 'typeorm'

// One bucket of input and output tokens. A finished run adds to the row for its
// workspace, flow, model, and UTC day. The migration creates the unique key.
@Entity('token_usage_day')
@Index('UQ_token_usage_day_bucket', ['workspaceId', 'flowId', 'model', 'day'], { unique: true })
export class TokenUsageDay {
    @PrimaryColumn({ type: 'varchar' })
    id: string

    @Column({ type: 'varchar' })
    workspaceId: string

    @Column({ type: 'varchar' })
    flowId: string

    @Column({ type: 'varchar' })
    model: string

    @Column({ type: 'varchar', length: 10 })
    day: string

    @Column({ type: 'int', default: 0 })
    inputTokens: number

    @Column({ type: 'int', default: 0 })
    outputTokens: number
}
