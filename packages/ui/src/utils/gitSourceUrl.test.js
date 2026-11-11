import { gitSourceUrlHint } from './gitSourceUrl'

describe('gitSourceUrlHint', () => {
    it('is quiet for empty values, repo URLs, and GitHub folder or file links', () => {
        expect(gitSourceUrlHint('')).toBe('')
        expect(gitSourceUrlHint('https://github.com/hashicorp/web-unified-docs.git')).toBe('')
        expect(gitSourceUrlHint('https://github.com/hashicorp/web-unified-docs/tree/main/content/')).toBe('')
        expect(gitSourceUrlHint('https://github.com/org/repo/blob/main/README.md')).toBe('')
        expect(gitSourceUrlHint('https://github.com/org/repo/blob/main/100%25.md')).toBe('')
        expect(gitSourceUrlHint('https://github.com/org/repo/blob/main/literal%2520name.md')).toBe('')
        expect(gitSourceUrlHint('https://example.com/org/repo.git')).toBe('')
    })

    it('explains when the URL cannot be cloned', () => {
        expect(gitSourceUrlHint('git@github.com:org/repo.git')).toBe('Use the https address of the repository. SSH URLs are not cloned.')
        expect(gitSourceUrlHint('https://github.com/org/repo/issues/1')).toBe(
            'This GitHub page cannot be cloned. Use the repository URL, or a folder or file link (/tree/ or /blob/).'
        )
        expect(gitSourceUrlHint('https://github.com/org/repo/tree/main/%2e%2e%2fsecret')).toBe(
            'The folder in this URL is not a path inside the repository.'
        )
        expect(gitSourceUrlHint('http://github.com/org/repo.git')).toBe('Code Repository clones https URLs only.')
        expect(gitSourceUrlHint('https://gitlab.com/org/repo/tree/main/docs')).toBe(
            'Use a git repository URL, not a web page. GitHub folder and file links are supported.'
        )
    })
})
