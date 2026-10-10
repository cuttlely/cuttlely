import { Plan } from './plan'

export type BuilderKind = 'workflow' | 'harness' | 'etl' | 'chat'

// A component definition as the nodes pool holds it. Only the fields the builder reads.
export interface PartDefinition {
    name: string
    label?: string
    description?: string
    category?: string
    type?: string
    baseClasses?: string[]
    inputs?: Array<Record<string, any>>
    outputs?: Array<Record<string, any>>
    credential?: Record<string, any>
    hideOutput?: boolean
    hideInput?: boolean
    [key: string]: any
}

// The chat model that builds, as the Build with AI dialog sends it: a chat model component name and its
// settings, including the credential id picked from the Credentials page.
export interface BuildingModel {
    name: string
    inputs?: Record<string, any>
    credential?: string
    [key: string]: any
}

export interface CredentialSummary {
    id: string
    name: string
    credentialName: string
}

export interface RecipeContext {
    componentNodes: Record<string, PartDefinition>
    chatModel: BuildingModel
    credentials: CredentialSummary[]
    // Credential type labels as the Credentials page shows them ("OpenAI API" for openAIApi).
    credentialLabels?: Record<string, string>
    // Saved harness names. A chatflow may attach only one of these; with none saved, the harness part is not offered.
    harnessNames?: string[]
}

// A credential a card needs that the Credentials page does not have yet, listed by name for the person.
export interface MissingCredential {
    part: string
    credential: string
}

export interface BuiltCanvas {
    nodes: any[]
    edges: any[]
    missingCredentials: MissingCredential[]
}

// One canvas: what it may use, what it learns from, its rules, its own check and how a plan becomes cards.
export interface Recipe {
    kind: BuilderKind
    // The parts the model may use, by node name.
    parts(ctx: RecipeContext): PartDefinition[]
    // A short list of the parts for the prompt.
    partsSummary(ctx: RecipeContext): string
    // The 3 to 5 most relevant bundled examples, as plans.
    examples(request: string, ctx: RecipeContext): Array<{ title: string; description: string; plan: Plan }>
    // Rules in plain words, sent to the model and repeated in the repair round.
    rules: string[]
    // Problems specific to this canvas, in plain words. The shared check runs first.
    check(plan: Plan, ctx: RecipeContext): string[]
    // Cards and connections for a plan that passed the check.
    materialize(plan: Plan, ctx: RecipeContext): BuiltCanvas
}
