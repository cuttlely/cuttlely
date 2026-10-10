import { Plan } from './plan'

export const STARTER_QUESTIONS = 3
const MAX_QUESTION_CHARS = 200

// Problems every canvas shares. Nothing is dropped: an unknown part, a connection to a missing card or a
// missing starter question is reported, so the repair round can fix it or the person sees why it failed.
export function sharedProblems(plan: Plan, partNames: Set<string>): string[] {
    const problems: string[] = []
    if (!plan.nodes.length) problems.push('The plan has no parts.')
    const seen = new Set<string>()
    plan.nodes.forEach((node, index) => {
        if (!node.id) problems.push(`Part ${index + 1} has no id.`)
        else if (seen.has(node.id)) problems.push(`Two parts share the id "${node.id}".`)
        else seen.add(node.id)
        if (!node.name) problems.push(`Part "${node.id || index + 1}" has no name.`)
        else if (!partNames.has(node.name)) problems.push(`"${node.name}" (part "${node.id}") is not a part this canvas can use.`)
    })
    plan.edges.forEach((edge, index) => {
        const label = `Connection ${index + 1} (${edge.from || '?'} to ${edge.to || '?'})`
        if (!edge.from || !seen.has(edge.from)) problems.push(`${label} starts at a part that is not in the plan.`)
        if (!edge.to || !seen.has(edge.to)) problems.push(`${label} ends at a part that is not in the plan.`)
        if (edge.from && edge.from === edge.to) problems.push(`${label} connects a part to itself.`)
    })
    const questions = plan.starterQuestions.filter((q) => q)
    if (questions.length !== STARTER_QUESTIONS || plan.starterQuestions.length !== STARTER_QUESTIONS)
        problems.push(`Give exactly ${STARTER_QUESTIONS} starter questions someone could ask the finished flow.`)
    if (questions.some((q) => q.length > MAX_QUESTION_CHARS))
        problems.push(`Keep each starter question under ${MAX_QUESTION_CHARS} characters.`)
    return problems
}
