import fs from 'fs'
import path from 'path'
import { CODE_INPUT_WARNING } from './overrideConfigWarning'

describe('Override Config code input warning', () => {
    it('uses the same words as the override configuration reference', () => {
        const doc = fs.readFileSync(path.resolve(__dirname, '../../../../../docs/reference/override-config.md'), 'utf8')
        expect(doc).toContain(CODE_INPUT_WARNING)
    })
})
