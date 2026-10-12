import fs from 'fs'
import path from 'path'
import { GIT_WORDS, gitWordsIn, messagesInSource } from '../../utils/plainWords'
import { classifyFailure } from './github'

// Every message the GitHub card can show: no Git words such as main, branch, commit or push.
// The scanner and its own tests are in utils/plainWords. The messages live with the versioning core.
describe('plain words on screen', () => {
    const githubSource = path.join(__dirname, '../../../../versioning/src/github.ts')
    const messagesIn = (file: string) => messagesInSource(fs.readFileSync(file, 'utf8'))

    test('every message in github.ts uses no Git words', () => {
        expect(messagesIn(githubSource).length).toBeGreaterThan(40)
        expect(gitWordsIn(fs.readFileSync(githubSource, 'utf8'))).toEqual([])
    })

    test('the scan sees messages built in local variables and ternaries', () => {
        const messages = messagesIn(githubSource)
        expect(messages).toContain('Up to date. Every version on this server is on GitHub.')
        expect(messages).toContain('Copying to GitHub now.')
        expect(messages.some((text) => text.startsWith('Could not reach GitHub to check X.'))).toBe(true)
    })

    test.each([
        'remote: error: GH006: Protected branch update failed',
        ' ! [rejected]        main -> main (fetch first)',
        'fatal: Authentication failed',
        'fatal: unable to access: Could not resolve host: github.com',
        'something new'
    ])('the message for %j uses no Git words', (stderr) => {
        expect(GIT_WORDS.test(classifyFailure(stderr, 'acme/flows').message)).toBe(false)
    })
})
