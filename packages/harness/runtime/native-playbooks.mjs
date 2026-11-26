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
            description: 'Read a saved playbook by name.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string' },
                    file_path: { type: 'string', description: 'Use SKILL.md for the playbook itself.' }
                },
                required: ['name'],
                additionalProperties: false
            }
        }
    }
]

// Resolve against this admitted specialist's roster. Even qualified names never become host paths.
export function readPlaybookTool(playbooks, tool, args) {
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
    return {
        success: true,
        name: book.name,
        description: book.description,
        path: PLAYBOOK_DIR + '/' + book.name + '/SKILL.md',
        content: playbookMarkdown(book),
        tags: [],
        related_skills: [],
        linked_files: null
    }
}
