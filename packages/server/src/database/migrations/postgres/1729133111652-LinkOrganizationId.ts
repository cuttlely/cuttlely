/**
 * Copyright 2026 The Cuttlely Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */
import { MigrationInterface, QueryRunner } from 'typeorm'
import { linkOrganizationUp, linkOrganizationDown } from '../../identitySchema'

export class LinkOrganizationId1729133111652 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await linkOrganizationUp(queryRunner)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await linkOrganizationDown(queryRunner)
    }
}
