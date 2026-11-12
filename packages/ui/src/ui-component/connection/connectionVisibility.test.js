import { connectionChipTransition } from './connectionVisibility'

describe('connection chip timing', () => {
    test('delays its first appearance and hides immediately', () => {
        expect(connectionChipTransition(1, false)).toEqual({ visible: false, delay: 250 })
        expect(connectionChipTransition(1, true)).toEqual({ visible: true, delay: null })
        expect(connectionChipTransition(0, true)).toEqual({ visible: false, delay: null })
    })
})
