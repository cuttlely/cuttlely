import { Column, Entity, PrimaryColumn } from 'typeorm'

/** A bounded ownership receipt for authenticated Dashflows reports. No content. */
@Entity('apikey_report')
export class ApiKeyReport {
    @PrimaryColumn({ type: 'varchar', length: 36 })
    runId: string

    @Column({ type: 'varchar', length: 36 })
    principalId: string

    @Column({ type: 'varchar', length: 64 })
    dashboardId: string

    @Column({ type: Date })
    createdAt: Date
}
