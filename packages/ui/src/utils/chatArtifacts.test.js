import { fileArtifactHref, imageArtifactDownload, resolveChatArtifacts } from './chatArtifacts'

const BASE = 'https://cuttlely.example'

test('first-turn artifacts are relinked when metadata supplies the server chat id, without a reload', () => {
    const artifactsEvent = [
        { type: 'png', data: 'FILE-STORAGE::harness_x_1_0_chart.png', name: 'chart.png', extra: 'keep' },
        { type: 'pdf', data: 'FILE-STORAGE::harness_x_1_1_R&D #2+deck.pdf' }
    ]
    const pending = resolveChatArtifacts(artifactsEvent, BASE, 'flow-1', 'client-uuid')
    expect(pending.every((item) => new URL(item.data).searchParams.get('chatId') === 'client-uuid')).toBe(true)
    const metadata = { chatId: 'server-id' }
    const final = resolveChatArtifacts(pending, BASE, 'flow-1', metadata.chatId)
    const hrefs = [imageArtifactDownload(final[0], BASE).href, fileArtifactHref(final[1], BASE)]
    expect(hrefs).toEqual([
        `${BASE}/api/v1/get-upload-file?chatflowId=flow-1&chatId=server-id&fileName=harness_x_1_0_chart.png&download=true`,
        `${BASE}/api/v1/get-upload-file?chatflowId=flow-1&chatId=server-id&fileName=harness_x_1_1_R%26D+%232%2Bdeck.pdf&download=true`
    ])
    for (const href of hrefs) {
        expect(new URL(href).searchParams.get('chatId')).toBe('server-id')
        expect(href).not.toContain('client-uuid')
    }
    expect(new URL(hrefs[1]).searchParams.get('fileName')).toBe('harness_x_1_1_R&D #2+deck.pdf')
    expect(final[0]).toMatchObject({ storedReference: artifactsEvent[0].data, name: 'chart.png', extra: 'keep' })
    expect(artifactsEvent[0].data).toBe('FILE-STORAGE::harness_x_1_0_chart.png')
    expect(pending[0].data).toContain('chatId=client-uuid')
    // A non-streaming response can resolve directly using its metadata id.
    expect(resolveChatArtifacts(artifactsEvent, BASE, 'flow-1', metadata.chatId)).toEqual(final)
    // The retained reference survives serialization without altering display or downloads.
    expect(resolveChatArtifacts(JSON.parse(JSON.stringify(final)), BASE, 'flow-1', metadata.chatId)).toEqual(final)
})

test('leaves data URLs, existing history links, and other artifact fields intact', () => {
    const artifacts = [
        { type: 'png', data: 'data:image/png;base64,YQ==' },
        { type: 'pdf', data: 'data:application/pdf;base64,YQ==' },
        { type: 'png', data: `${BASE}/api/v1/get-upload-file?chatId=saved&fileName=chart.png` },
        { type: 'html', data: '<p>hello</p>', extra: 'keep' }
    ]
    expect(resolveChatArtifacts(artifacts, BASE, 'flow-1', 'server-id')).toEqual(artifacts)
    expect(resolveChatArtifacts(undefined, BASE, 'flow-1', 'server-id')).toBeUndefined()
})
