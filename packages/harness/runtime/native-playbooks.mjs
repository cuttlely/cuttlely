import { CHARS_PER_TOKEN } from '../context.mjs'
import { PLAYBOOK_DIR, playbookMarkdown } from '../profile.mjs'

export const playbookTools = [
    {
        type: 'function',
        function: {
            name: 'skills_list',
            description: 'List the saved playbooks available to this specialist.',
            parameters: { type: 'object', properties: { category: { type: 'string' } }, additionalProperties: false }
        }
    },
    {
        type: 'function',
        function: {
            name: 'skill_view',
            description: 'Read a saved playbook. For long playbooks, pass next_offset as offset to read the next page.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    offset: { type: 'integer', minimum: 0, description: 'Offset returned by a previous page.' },
                    file_path: { type: 'string', description: 'Use SKILL.md for the playbook itself.' }
                },
                required: ['name'],
                additionalProperties: false
            }
        }
    }
]

export function playbookCallLimit(playbooks, budget) {
    // Allow discovery, page reads and Calculator calls while bounding repeated model requests.
    const pages = playbooks.reduce((sum, book) => sum + 1 + (budget ? Math.ceil(JSON.stringify(book.content).length / budget) : 0), 0)
    return Math.min(128, pages + 8)
}

// Resolve against this admitted specialist's roster. Even qualified names never become host paths.
export function readPlaybookTool(playbooks, tool, args, budget = 0) {
    if (tool === 'skills_list') {
        const skills = (!args.category || args.category === PLAYBOOK_DIR ? playbooks : [])
            .map(({ name, description }) => ({ name, description, category: PLAYBOOK_DIR }))
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        return { success: true, skills, categories: skills.length ? [PLAYBOOK_DIR] : [], count: skills.length }
    }
    const book = playbooks.find(({ name }) => [name, PLAYBOOK_DIR + '/' + name, PLAYBOOK_DIR + ':' + name].includes(args.name))
    if (tool !== 'skill_view' || !book || (args.file_path !== undefined && args.file_path !== '' && args.file_path !== 'SKILL.md')) {
        return { success: false, error: 'This specialist has no such saved playbook or file.' }
    }
    const markdown = playbookMarkdown(book)
    const start = args.offset ?? 0
    if (!Number.isSafeInteger(start) || start < 0 || start > markdown.length)
        return { success: false, error: 'Invalid playbook page offset.' }
    // Size the encoded text the model actually receives. Leave room for the task and tool envelope.
    const pageChars = budget ? Math.max(2, Math.floor((budget * CHARS_PER_TOKEN) / 3)) : Infinity
    let end = Math.min(markdown.length, start + pageChars)
    while (end > start + 1 && JSON.stringify(markdown.slice(start, end)).length - 2 > pageChars) end = start + Math.floor((end - start) / 2)
    if (end < markdown.length && end > start + 1 && /[\uD800-\uDBFF]/.test(markdown[end - 1])) end--
    return {
        success: true,
        name: book.name,
        description: book.description,
        path: PLAYBOOK_DIR + '/' + book.name + '/SKILL.md',
        content: markdown.slice(start, end),
        ...(start || end < markdown.length ? { offset: start, next_offset: end < markdown.length ? end : null } : {}),
        tags: [],
        related_skills: [],
        linked_files: null
    }
}
