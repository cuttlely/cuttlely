import { Column, Entity, PrimaryColumn } from 'typeorm'

/** Only current UTC day/month buckets are retained. No request payloads or request log. */
@Entity('apikey_usage')
export class ApiKeyUsage {
    @PrimaryColumn({ type: 'varchar', length: 36 })
    principalId: string

    @PrimaryColumn({ type: 'varchar', length: 10 })
    period: string

    @PrimaryColumn({ type: 'varchar', length: 32 })
    operation: string

    @Column({ type: 'integer', default: 0 })
    accepted: number

    @Column({ type: Date, nullable: true })
    lastUsedAt: Date | null
}
