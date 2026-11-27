import { createRequire } from 'node:module'

// The node package publishes the read-only input shapes supported by the native runtime.
// Using its data export also works before the component TypeScript build has run.
const components = createRequire(new URL('../packages/components/package.json', import.meta.url))
const supported = components('@cuttlely/components/native-canvas-bindings')

function matches(binding, shape) {
    if (!binding || Array.isArray(binding) || binding.nodeData || (shape.type && binding.nodeName !== shape.type)) return false
    if (shape.credential && (typeof binding.credential !== 'string' || !binding.credential.trim())) return false
    if (shape.output && binding.outputs?.output !== shape.output) return false
    const inputs = binding.inputs || {}
    if (shape.inputs && Object.keys(inputs).some((name) => !shape.inputs.includes(name))) return false
    if (Object.entries(shape.equals || {}).some(([name, value]) => inputs[name] !== value)) return false
    if (shape.empty?.some((name) => inputs[name])) return false
    if (shape.credentialInput && inputs[shape.credentialInput] && inputs[shape.credentialInput] !== binding.credential) return false
    // A filter set by the tool must never replace a restriction on the attached source.
    if (shape.incompatibleInputs?.some((pair) => pair.every((path) => path.split('.').reduce((item, key) => item?.[key], binding))))
        return false
    const upstream = binding.upstream || {}
    const required = shape.upstream || {}
    return (
        Object.keys(upstream).every(
            (key) =>
                Object.hasOwn(required, key) ||
                (Object.hasOwn(shape.optionalUpstream || {}, key) && matches(upstream[key], shape.optionalUpstream[key]))
        ) && Object.entries(required).every(([key, child]) => matches(upstream[key], child))
    )
}

export function supportsNativeCanvasBinding(binding) {
    return Object.hasOwn(supported, binding?.nodeName) && matches(binding, supported[binding.nodeName])
}

export function needsNativeCanvasCredential(binding) {
    return Boolean(supported[binding?.nodeName]?.credential && (typeof binding.credential !== 'string' || !binding.credential.trim()))
}
