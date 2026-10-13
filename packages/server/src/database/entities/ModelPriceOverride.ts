import { Column, Entity, Index, PrimaryColumn } from 'typeorm'

// An organization owner's price for one model, in US dollars per million tokens.
// Absent rows use the model list. The migration creates the unique key.
@Entity('model_price_override')
@Index('UQ_model_price_override', ['organizationId', 'model'], { unique: true })
export class ModelPriceOverride {
    @PrimaryColumn({ type: 'varchar' })
    id: string

    @Column({ type: 'varchar', length: 36 })
    organizationId: string

    @Column({ type: 'varchar', length: 255 })
    model: string

    @Column({ type: 'varchar', length: 32 })
    inputUsdPerMillion: string

    @Column({ type: 'varchar', length: 32 })
    outputUsdPerMillion: string
}
