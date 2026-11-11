// A request that gets no answer has no `response`. Error handlers must not read `error.response.data`
// without checking it first, or the handler throws instead of showing a message.
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const sources = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) return entry.name === '__mocks__' ? [] : sources(full)
        return /\.(js|jsx)$/.test(entry.name) && !/\.test\.js$/.test(entry.name) ? [full] : []
    })

describe('error handlers read a response only when there is one', () => {
    const files = sources(root)

    it('no handler picks the message with an unguarded typeof error.response.data check', () => {
        const unguarded = /typeof \w+\.response\.data === 'object'/
        expect(files.filter((file) => unguarded.test(fs.readFileSync(file, 'utf8'))).map((file) => path.relative(root, file))).toEqual([])
    })

    it('no handler builds a status line from a response it did not check', () => {
        const unguarded = /=\s*\w+\.response\.data \|\| `\$\{\w+\.response\.status\}/
        expect(files.filter((file) => unguarded.test(fs.readFileSync(file, 'utf8'))).map((file) => path.relative(root, file))).toEqual([])
    })

    it('no handler hides requestFailureMessage behind a response-body branch', () => {
        const guarded = /if\s*\([^)]*response\?\.data[^)]*\)\s*\{[^}]*requestFailureMessage\(/s
        expect(files.filter((file) => guarded.test(fs.readFileSync(file, 'utf8'))).map((file) => path.relative(root, file))).toEqual([])
    })

    it('canvas configuration save handlers use the write-safe setting message', () => {
        const handlers = [
            'ui-component/extended/AllowedDomains.jsx',
            'ui-component/extended/AnalyseFlow.jsx',
            'ui-component/extended/ChatFeedback.jsx',
            'ui-component/extended/EnhancedStatusMessages.jsx',
            'ui-component/extended/FileUpload.jsx',
            'ui-component/extended/FollowUpPrompts.jsx',
            'ui-component/extended/Leads.jsx',
            'ui-component/extended/McpServer.jsx',
            'ui-component/extended/OverrideConfig.jsx',
            'ui-component/extended/PostProcessing.jsx',
            'ui-component/extended/RateLimit.jsx',
            'ui-component/extended/ShowToolEvents.jsx',
            'ui-component/extended/SpeechToText.jsx',
            'ui-component/extended/StarterPrompts.jsx',
            'ui-component/extended/TextToSpeech.jsx'
        ]
        expect(
            handlers.filter((file) => {
                const source = fs.readFileSync(path.join(root, file), 'utf8')
                return !source.includes('settingFailureMessage(error') || source.includes('requestFailureMessage(')
            })
        ).toEqual([])
    })

    it('every handler that calls requestFailureMessage imports it', () => {
        const missing = files.filter((file) => {
            const source = fs.readFileSync(file, 'utf8')
            if (!source.includes('requestFailureMessage(') || source.includes('export const requestFailureMessage')) return false
            return !/import\s*\{[^}]*\brequestFailureMessage\b[^}]*\}\s*from\s*['"]@\/utils\/errorSummary['"]/s.test(source)
        })
        expect(missing.map((file) => path.relative(root, file))).toEqual([])
    })
})
