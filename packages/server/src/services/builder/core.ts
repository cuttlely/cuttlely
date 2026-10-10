import { sharedProblems, STARTER_QUESTIONS } from './check'
import { extractJson, Plan, toPlan } from './plan'
import { MissingCredential, Recipe, RecipeContext } from './recipe'

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }
export type Ask = (messages: ChatMessage[]) => Promise<string>

export type BuildResult =
    | {
          ok: true
          title?: string
          nodes: any[]
          edges: any[]
          starterQuestions: string[]
          missingCredentials: MissingCredential[]
          repaired: boolean
      }
    | { ok: false; problems: string[]; repaired: boolean }

const PLAN_FORMAT = `Reply with one JSON object and nothing else:
{
  "title": "a short name for what you built",
  "nodes": [ { "id": "unique id", "name": "part name from the list", "label": "a short card title", ... } ],
  "edges": [ { "from": "node id", "to": "node id" } ],
  "starterQuestions": ["three questions someone could ask the finished flow"]
}
Optional node fields: "instructions" (what the part should do, in plain words), "tools" (tool names), "scenarios",
"parent", "loopBackTo", "credential" (a credential name, never a key), "inputs" (plain settings by input name).
Optional edge fields: "branch" (route number on a branching part, 0 first), "input" (the plug on the target card).`

export function systemPrompt(recipe: Recipe, request: string, ctx: RecipeContext): string {
    const examples = recipe
        .examples(request, ctx)
        .map((example, index) => `Example ${index + 1}: ${example.title}. ${example.description}\n${JSON.stringify(example.plan)}`)
        .join('\n\n')
    return [
        `You build a Cuttlely ${recipe.kind} canvas from a plain description.`,
        PLAN_FORMAT,
        `Parts you can use:\n${recipe.partsSummary(ctx)}`,
        `Rules:\n${recipe.rules.map((rule) => `- ${rule}`).join('\n')}`,
        `- Give exactly ${STARTER_QUESTIONS} starter questions: what a person would type into the chat to get real work done, never questions about how the flow itself works.`,
        examples ? `Examples of finished ${recipe.kind}s:\n${examples}` : ''
    ]
        .filter(Boolean)
        .join('\n\n')
}

export function planProblems(recipe: Recipe, plan: Plan, ctx: RecipeContext): string[] {
    const names = new Set(recipe.parts(ctx).map((part) => part.name))
    const shared = sharedProblems(plan, names)
    // The canvas check reads part definitions, so it only runs on a plan whose parts are all known.
    if (!plan.nodes.length || plan.nodes.some((node) => !node.id || !names.has(node.name))) return shared
    return [...shared, ...recipe.check(plan, ctx)]
}

async function askForPlan(ask: Ask, messages: ChatMessage[]): Promise<{ reply: string; plan?: Plan; problem?: string }> {
    const reply = await ask(messages)
    try {
        return { reply, plan: toPlan(extractJson(reply)) }
    } catch (error) {
        return { reply, problem: (error as Error).message }
    }
}

// Describe, plan, check, one repair round with the check's own words, then place. Nothing is saved here:
// the canvas gets the result unsaved, and a failed build changes nothing.
export async function runBuilder(recipe: Recipe, request: string, ctx: RecipeContext, ask: Ask): Promise<BuildResult> {
    const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt(recipe, request, ctx) },
        { role: 'user', content: request }
    ]
    let attempt = await askForPlan(ask, messages)
    let problems = attempt.plan ? planProblems(recipe, attempt.plan, ctx) : [attempt.problem as string]
    let repaired = false
    if (problems.length) {
        repaired = true
        messages.push({ role: 'assistant', content: attempt.reply })
        messages.push({
            role: 'user',
            content: `The plan has these problems:\n${problems
                .map((p) => `- ${p}`)
                .join('\n')}\nFix every one and reply with the whole corrected JSON plan.`
        })
        attempt = await askForPlan(ask, messages)
        problems = attempt.plan ? planProblems(recipe, attempt.plan, ctx) : [attempt.problem as string]
    }
    if (problems.length || !attempt.plan) return { ok: false, problems, repaired }
    const plan = attempt.plan
    const built = recipe.materialize(plan, ctx)
    return {
        ok: true,
        title: plan.title,
        nodes: built.nodes,
        edges: built.edges,
        starterQuestions: plan.starterQuestions,
        missingCredentials: built.missingCredentials,
        repaired
    }
}
