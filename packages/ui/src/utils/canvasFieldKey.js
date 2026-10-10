// A stable React key for a canvas field: the card id plus the field name (and its place in a list, for list items).
// It must never include the field's value. A key built from the value changes on every keystroke, so React rebuilds the
// field and the cursor drops out after the first letter. Fields pick up outside changes (load, undo, a dialog) from
// their value prop instead.
export const canvasFieldKey = (data, inputParam, arrayIndex, parentParamForArray) =>
    [data?.id ?? '', parentParamForArray?.name ?? '', arrayIndex ?? '', inputParam?.name ?? ''].join('_')

// The output card remounts only when that output's own choice changes, so its dropdown shows a choice made elsewhere,
// and typing in an input on the same card leaves it alone.
export const canvasOutputKey = (data, outputAnchor) =>
    [data?.id ?? '', outputAnchor?.id ?? outputAnchor?.name ?? '', JSON.stringify(data?.outputs?.[outputAnchor?.name] ?? '')].join('_')

// What the variable menu of a rich-text field shows for each earlier node. The editor is rebuilt when its node list
// changes, and the canvas hands it a fresh array on every redraw, so compare what the menu shows instead of the array.
export const variableNodesSignature = (nodes) =>
    JSON.stringify(
        (nodes || []).map((node) => [
            node?.id,
            node?.data?.id,
            node?.data?.name,
            node?.data?.label,
            node?.data?.description,
            node?.data?.inputs?.chainName,
            node?.data?.inputs?.functionName,
            node?.data?.inputs?.variableName,
            node?.data?.outputs?.output
        ])
    )
