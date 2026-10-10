// Outcome labels for the first-run chooser. Routes stay the existing canvases.
// Legacy agentflows (V1) stay off this list. The agentflows page shows a Legacy link only when one already exists.

export const HARNESS_LABEL = 'Harness · Agent Team'

export const BUILD_CHOOSER_KEY = 'cuttlely.dismissed.buildChooser'

export const BRING_YOUR_FLOWS_URL = 'https://github.com/cuttlely/cuttlely/blob/main/docs/bring-your-flows.md'

export const BUILD_CHOICES = [
    {
        id: 'harness',
        outcome: 'Agent team',
        product: 'Harness',
        label: HARNESS_LABEL,
        createPath: '/harnesscanvas',
        permission: 'chatflows:create'
    },
    {
        id: 'chatflow',
        outcome: 'Chat / simple AI app',
        product: 'Chatflow',
        label: 'Chatflow',
        createPath: '/canvas',
        permission: 'chatflows:create'
    },
    {
        id: 'agentflow',
        outcome: 'Workflow / automation',
        product: 'Agentflow',
        label: 'Agentflow',
        createPath: '/v2/agentcanvas',
        permission: 'agentflows:create'
    },
    {
        id: 'etl',
        outcome: 'Knowledge / data pipeline',
        product: 'ETL',
        label: 'ETL',
        createPath: '/etlcanvas',
        permission: 'chatflows:create'
    }
]

export const GLOSSARY = [
    [
        'Harnesses',
        'an agent team your app can call. The sidebar says Harness · Agent Team: Harness Prime and specialists, called by name from a chatflow.'
    ],
    ['Chatflows', 'one chatbot or a simple flow you chat with.'],
    ['Agentflows', 'a multi-step workflow. Older legacy agentflows still run and open, but new ones always use the current canvas.'],
    [
        'Import',
        'on Chatflows, and on the canvas gear. Flowise JSON opens in the migration wizard before the canvas. A simple Langflow chat (one model and an optional prompt) loads from its own button. Any other Langflow graph says it is not supported yet.'
    ],
    ['Credentials', 'stay in this app. An import does not copy API keys. Create the credential, then select it on the chat model.']
]

export const chooserIsOpen = ({ dismissed, pinned }) => Boolean(pinned) || !dismissed
