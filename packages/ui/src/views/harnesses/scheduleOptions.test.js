import { ownerLabel, timeZoneOptions } from './scheduleOptions'

describe('harness schedule options', () => {
    it("lists the browser's own zone even when the supported list spells it another way", () => {
        expect(timeZoneOptions('Asia/Kolkata', ['Asia/Calcutta', 'Europe/Paris'])).toEqual([
            'UTC',
            'Asia/Kolkata',
            'Asia/Calcutta',
            'Europe/Paris'
        ])
        expect(timeZoneOptions('Europe/Paris', ['Europe/Paris'])).toEqual(['UTC', 'Europe/Paris'])
        expect(timeZoneOptions('', [])).toEqual(['UTC'])
    })

    it('names the owner without an email for an API key view', () => {
        expect(ownerLabel({ name: 'Sam Baker' })).toBe('Sam Baker')
        expect(ownerLabel({ name: null, email: 'sam@rosas-bakery.example' })).toBe('sam@rosas-bakery.example')
        expect(ownerLabel(null)).toBe('unknown')
    })
})
