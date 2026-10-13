/* eslint-disable */
import { Entity, Column, CreateDateColumn, UpdateDateColumn, PrimaryGeneratedColumn, Index } from 'typeorm'
import { IAssistant, IDataset, IDatasetRow } from '../../Interface'

@Entity()
export class DatasetRow implements IDatasetRow {
    @PrimaryGeneratedColumn('uuid')
    id: string

    @Column({ type: 'text' })
    @Index()
    datasetId: string

    @Column({ type: 'text' })
    input: string

    @Column({ type: 'text' })
    output: string

    @UpdateDateColumn()
    updatedDate: Date

    @Column({ name: 'sequence_no' })
    sequenceNo: number

    // Null on a row typed in or uploaded. A chat answer records where it was saved from.
    @Column({ nullable: true, type: 'varchar', length: 32 })
    sourceType?: string | null

    @Column({ nullable: true, type: 'varchar', length: 36 })
    sourceMessageId?: string | null

    @Column({ nullable: true, type: 'varchar', length: 36 })
    sourceFlowId?: string | null

    @Column({ nullable: true, type: 'datetime' })
    sourceDate?: Date | null

    // Set when the row was saved from a rating. Null on a row typed in, uploaded, or saved from one answer.
    @Column({ nullable: true, type: 'varchar', length: 36 })
    sourceFeedbackId?: string | null

    @Column({ nullable: true, type: 'varchar', length: 16 })
    sourceRating?: string | null

    @Column({ nullable: true, type: 'text' })
    sourceFeedbackText?: string | null

    // The answer a thumbs-down rejected. It is not the expected output.
    @Column({ nullable: true, type: 'text' })
    sourceRejectedAnswer?: string | null

    // True until someone writes the expected answer. A rejected answer is not that answer.
    @Column({ nullable: true, type: 'boolean', default: false })
    needsExpectedAnswer?: boolean | null
}
