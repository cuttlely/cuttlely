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
})
