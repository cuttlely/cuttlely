// The live status line on a running harness run card.
// Every line comes from an event the run already streamed (route, specialist, tool, handoff).
// packages/chat-widget/src/live-status.js is a byte-for-byte copy so the app chat and the embedded widget say the same thing.
// The optional enhanced lines are display only. They are never stored in a trace, chat history, or export.

export const LIVE_ANNOUNCE_GAP_MS = 4000
export const ENHANCED_DELAY_MS = 4000
export const ENHANCED_ROTATE_MS = 3500

// Generic on purpose: an enhanced line never names a specialist, tool, table, query, or data source.
// Each phase has its own pool, and no line appears in more than one pool.
export const ENHANCED_LINES = {
    route: [
        'Activating agent swarm…',
        'Spinning up the reasoning mesh…',
        'Checking available context windows…',
        'Mapping the intent graph…',
        'Scoring specialist affinity vectors…',
        'Bootstrapping the planner loop…',
        'Warming up the routing layer…',
        'Sharding the question into sub-goals…',
        'Negotiating the agent handshake…',
        'Resolving the task topology…',
        'Computing the optimal dispatch plan…',
        'Balancing the inference load…',
        'Embedding the request in latent space…',
        'Aligning the orchestration graph…',
        'Allocating the attention budget…',
        'Priming the zero-shot router…',
        'Consulting the mixture of experts…',
        'Plotting the agentic workflow…',
        'Tokenizing the intent…',
        'Selecting the reasoning strategy…',
        'Booting the multi-agent runtime…',
        'Assembling the dream team…',
        'Calibrating the semantic compass…',
        'Drafting the execution graph…'
    ],
    working: [
        'Performing deep analysis…',
        'Running multi-hop reasoning…',
        'Orchestrating parallel inference…',
        'Expanding the chain of thought…',
        'Decomposing the problem space…',
        'Grounding the hypotheses…',
        'Traversing the knowledge graph…',
        'Hydrating the working memory…',
        'Scaling test-time compute…',
        'Exploring the solution manifold…',
        'Running agentic planning cycles…',
        'Sampling candidate trajectories…',
        'Building the reasoning scaffold…',
        'Refining the latent plan…',
        'Propagating context through the stack…',
        'Tuning the attention heads…',
        'Crunching the high-dimensional signal…',
        'Running a self-consistency pass…',
        'Simulating counterfactuals…',
        'Iterating on the inner loop…',
        'Distilling the core question…',
        'Stacking the inference layers…',
        'Optimizing the token budget…',
        'Engaging deep focus mode…'
    ],
    tool: [
        'Cross-checking the numbers…',
        'Lining up the joins…',
        'Vectorizing the signal…',
        'Fusing retrieval results…',
        'Normalizing the feature space…',
        'Streaming results into the context window…',
        'Checking schema alignment…',
        'Deduplicating the evidence set…',
        'Indexing the fresh signal…',
        'Running hybrid retrieval…',
        'Chunking the payload…',
        'Computing similarity scores…',
        'Parsing structured output…',
        'Hardening the result set…',
        'Sanity-checking the aggregates…',
        'Ingesting the response stream…',
        'Warming the cache on the hot path…',
        'Pipelining the function calls…',
        'Running a semantic diff…',
        'Reconciling the data shards…',
        'Batching the inference requests…',
        'Extracting the high-signal rows…',
        'Stress-testing the edge cases…',
        'Checking the guardrails…'
    ],
    thinking: [
        'Weighing a few angles…',
        'Calibrating confidence intervals…',
        'Re-ranking candidate insights…',
        'Running a reflection pass…',
        'Synthesizing emergent patterns…',
        'Scoring the evidence…',
        'Pruning the hypothesis tree…',
        'Detecting anomalies in the signal…',
        'Triangulating the findings…',
        'Running Bayesian updates…',
        'Converging on a consensus…',
        'Debating with the critic agent…',
        'Collapsing the probability cloud…',
        'Reasoning over the embeddings…',
        'Measuring semantic drift…',
        'Red-teaming the conclusions…',
        'Fact-checking the reasoning chain…',
        'Rebalancing the attention weights…',
        'Extracting latent insights…',
        'Running an ensemble vote…',
        'Grading the reasoning path…',
        'Minimizing the loss of nuance…',
        'Clustering the main findings…',
        'Looking for second-order effects…'
    ],
    handoff: [
        'Polishing the wording…',
        'Double-checking the totals…',
        'Decoding the final tokens…',
        'Compressing insights into prose…',
        'Running the hallucination filter…',
        'Aligning the tone vectors…',
        'Rendering the narrative layer…',
        'Fine-tuning the phrasing…',
        'Assembling the executive summary…',
        'Applying the clarity optimizer…',
        'Grounding every claim…',
        'Formatting the output tensor…',
        'Smoothing the reasoning seams…',
        'Packaging the insight payload…',
        'Running a final coherence check…',
        'Beam-searching for the best sentence…',
        'Lowering the temperature for precision…',
        'Stitching the agent outputs together…',
        'Shipping the answer to the edge…',
        'Applying the finishing gradient…',
        'Condensing the answer to its essence…',
        'Converting thoughts to plain language…',
        'Running the last-mile alignment…',
        'Sealing the response envelope…'
    ]
}

const TOOL_PHRASES = {
    query: 'a SQL query',
    describe: 'a table description',
    list_tables: 'a table listing',
    list_relations: 'a table listing',
    pin_definition: 'a saved query lookup'
}

const SAVED_QUERY = /^pq_[a-z0-9_]+$/i

function shortToolName(name) {
    const text = String(name || '').trim()
    const match = /^mcp__(.+?)__(.+)$/.exec(text)
    return match ? match[2] : text
}

// "a SQL query" for the known analyst tools. Any other tool is named by the label the caller passes
// (the app chat passes its tool chip label), else by the tool's own name.
export function toolPhrase(tool, toolLabel) {
    const short = shortToolName(tool?.name)
    if (TOOL_PHRASES[short]) return TOOL_PHRASES[short]
    if (SAVED_QUERY.test(short)) return 'a saved query'
    const label = typeof toolLabel === 'function' ? toolLabel(tool) : ''
    return `${label || short || 'a tool'}`
}

function specialistStatus(specialist, toolLabel) {
    const tools = Array.isArray(specialist?.tools) ? specialist.tools : []
    // Tools can run side by side: name the latest one still running, and think only once none is.
    const running = tools.filter((tool) => tool?.status === 'running').pop()
    if (running) {
        const phrase = toolPhrase(running, toolLabel)
        return { phase: 'tool', row: `Running ${phrase}…`, verb: `is running ${phrase}…` }
    }
    if (tools.length) return { phase: 'thinking', row: 'Thinking about the results…', verb: 'is thinking about the results…' }
    return { phase: 'working', row: 'Working…', verb: 'is working…' }
}

/**
 * The status of a running trace: { line, phase, perSpecialist } or null once the run has ended.
 * trace: { status, route: { status }, handoff: { status }, specialists: [{ name, status, tools: [{ name, status }] }] }.
 * phase is one of start, route, working, tool, thinking, handoff, waiting.
 */
export function liveStatus(trace, { toolLabel } = {}) {
    if (!trace || trace.status !== 'running') return null
    const specialists = Array.isArray(trace.specialists) ? trace.specialists : []
    const perSpecialist = {}
    let main = null
    for (const specialist of specialists) {
        if (specialist?.status !== 'running') continue
        const status = specialistStatus(specialist, toolLabel)
        perSpecialist[specialist.name] = status.row
        // A specialist running a tool is the most specific thing to say; otherwise the latest one to start.
        if (!main || status.phase === 'tool' || main.status.phase !== 'tool') main = { name: specialist.name, status }
    }
    const handoff = trace.handoff?.status
    if (handoff === 'running' || handoff === 'done') {
        return { line: 'Pulling it together and writing the answer…', phase: 'handoff', perSpecialist }
    }
    if (main) return { line: `${main.name} ${main.status.verb}`, phase: main.status.phase, perSpecialist }
    const route = trace.route?.status
    const started = specialists.some((item) => item && item.status !== 'running' && item.status !== 'queued')
    if (route === 'running' || (route === 'done' && !started)) return { line: 'Picking specialists…', phase: 'route', perSpecialist }
    if (route === 'done' || started) return { line: 'Working…', phase: 'waiting', perSpecialist }
    return { line: 'Starting…', phase: 'start', perSpecialist }
}

// Fisher-Yates shuffle of a copy. random returns a number in [0, 1), like Math.random.
export function shuffleLines(lines, random = Math.random) {
    const order = [...lines]
    for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1))
        ;[order[i], order[j]] = [order[j], order[i]]
    }
    return order
}

// Draws lines without replacement until every line has shown, then reshuffles.
// The first line of a new cycle is never the last line of the cycle before it.
export function createLineDeck(lines, random = Math.random) {
    let order = []
    let last = null
    return {
        next() {
            if (!lines.length) return ''
            if (!order.length) {
                order = shuffleLines(lines, random)
                // Lines are drawn from the end, so the end is the first line of the new cycle.
                const end = order.length - 1
                if (end > 0 && order[end] === last) {
                    order[end] = order[0]
                    order[0] = last
                }
            }
            last = order.pop()
            return last
        }
    }
}

// One per run card. line(phase, sinceMs, enabled) is the enhanced line for a phase that has shown the same real
// line for sinceMs, or '' when there is none. The line holds for ENHANCED_ROTATE_MS, then the next one is drawn from
// that phase's deck. A new real line (sinceMs back under the delay) clears it.
export function createEnhancedRotator({ random = Math.random } = {}) {
    const decks = {}
    let shown = null
    return {
        line(phase, sinceMs, enabled = true) {
            const list = ENHANCED_LINES[phase]
            if (!enabled || !list || !Number.isFinite(sinceMs) || sinceMs < ENHANCED_DELAY_MS) {
                shown = null
                return ''
            }
            const slot = Math.floor((sinceMs - ENHANCED_DELAY_MS) / ENHANCED_ROTATE_MS)
            if (shown && shown.phase === phase && shown.slot === slot) return shown.text
            if (!decks[phase]) decks[phase] = createLineDeck(list, random)
            shown = { phase, slot, text: decks[phase].next() }
            return shown.text
        }
    }
}

// Screen readers hear a new status line at most once per gap. The timer and enhanced lines are never announced.
export function nextAnnouncement(previous, line, now, gap = LIVE_ANNOUNCE_GAP_MS) {
    const prev = previous || { text: '', at: -Infinity }
    if (!line || line === prev.text || now - prev.at < gap) return prev
    return { text: line, at: now }
}

// "0:07", "1:05", "1:02:03" for the ticking timer.
export function formatElapsed(ms) {
    const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
    const hours = Math.floor(total / 3600)
    const minutes = Math.floor((total % 3600) / 60)
    const seconds = String(total % 60).padStart(2, '0')
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`
}
