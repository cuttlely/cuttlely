import { invitationResults } from './invitePayload'

describe('bulk invitation links', () => {
    it('keeps returned links paired with their email and leaves the dialog open', () => {
        const selected = [
            { isNewUser: true, email: 'ada@example.com' },
            { isNewUser: false, user: { email: 'grace@example.com' } },
            { isNewUser: true, email: 'lin@example.com' }
        ]
        const result = invitationResults(selected, [
            { link: 'https://example.test/ada' },
            { id: 'grace' },
            { link: 'https://example.test/lin' }
        ])

        expect(result).toEqual({
            keepOpen: true,
            links: [
                { email: 'ada@example.com', link: 'https://example.test/ada' },
                { email: 'lin@example.com', link: 'https://example.test/lin' }
            ]
        })
        expect(invitationResults(selected, [{ id: 'ada' }, { id: 'grace' }, { id: 'lin' }]).keepOpen).toBe(false)
    })

    it('closes normally when no response includes a link', () => {
        const selected = [
            { isNewUser: false, user: { email: 'ada@example.com' } },
            { isNewUser: false, user: { email: 'lin@example.com' } }
        ]

        expect(invitationResults(selected, [{ id: 'ada' }, { id: 'lin' }])).toEqual({ keepOpen: false, links: [] })
    })
})
