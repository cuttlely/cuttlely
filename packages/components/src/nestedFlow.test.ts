import { isSameServerBaseURL } from './nestedFlow'

it('matches only the parent server URL, allowing harmless trailing-slash spelling', () => {
    expect(isSameServerBaseURL('http://localhost:3000', 'http://localhost:3000/')).toBe(true)
    expect(isSameServerBaseURL('https://example.test/base/', 'https://example.test/base')).toBe(true)
    expect(isSameServerBaseURL('http://127.0.0.1:3000', 'http://localhost:3000')).toBe(false)
    expect(isSameServerBaseURL('https://example.test/remote', 'https://example.test')).toBe(false)
    expect(isSameServerBaseURL('not-a-url', 'http://localhost:3000')).toBe(false)
})
