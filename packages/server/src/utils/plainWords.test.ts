import { GIT_WORDS, gitWordsIn, messagesInSource } from './plainWords'

describe('plainWords', () => {
    test('reads every quote style, joins strings built with +, and skips comments, Git arguments and log lines', () => {
        const sample = [
            'const a = "GitHub\'s default line is protected."',
            "const b = 'Could not copy this version.'",
            'const c = `Copying ${count} versions now.`',
            '// Merging is a comment and never on screen.',
            "const d = 'Copied ' + count + ' versions to ' +",
            "    repo + '.'",
            "git(['push', '--force', 'refs/heads/' + line])",
            "const e = 'HEAD'",
            "logger.info('[versions] pushing ' + id)"
        ].join('\n')
        expect(messagesInSource(sample).sort()).toEqual(
            [
                'Copying X versions now.',
                "GitHub's default line is protected.",
                'Could not copy this version.',
                'Copied X versions to X.'
            ].sort()
        )
        expect(gitWordsIn(sample)).toEqual([])
    })

    test('catches a Git word in a one-word label or in a message split across + pieces', () => {
        const sample = [
            "const label = done ? 'Merged' : 'Pushing…'",
            "const short = 'fetched.'",
            "throw new Error('Could not ' + 'push' + ' this version.')",
            "const status = `Up to date with ` + 'main'"
        ].join('\n')
        expect(gitWordsIn(sample).sort()).toEqual(
            ['Could not push this version.', 'Merged', 'Pushing…', 'Up to date with main', 'fetched.'].sort()
        )
    })

    test('the word list catches every inflection and leaves plain words alone', () => {
        for (const message of [
            "GitHub's main branch is protected.",
            'Merging histories now.',
            'Rebasing is disabled.',
            'Fetching changes now.',
            'Cloning is disabled.',
            'Forced updates are disabled.',
            'Pushes are queued.',
            'Two commits behind.'
        ])
            expect([message, GIT_WORDS.test(message)]).toEqual([message, true])
        for (const message of ['Copying to GitHub now.', 'Live flows keep working.', 'Could not reach GitHub.', 'Promoted from Dev'])
            expect([message, GIT_WORDS.test(message)]).toEqual([message, false])
    })
})
