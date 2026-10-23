jest.mock('@/store/constant', () => ({ baseURL: 'https://cuttlely.example' }))

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import FileArtifact from './FileArtifact'
import { fileArtifactHref, fileArtifactName, isFileArtifact, storedFileArtifactUrl } from '@/utils/chatArtifacts'

const BASE = 'https://cuttlely.example'
const render = (item) => renderToStaticMarkup(createElement(ThemeProvider, { theme: createTheme() }, createElement(FileArtifact, { item })))

describe('file artifacts in the chat', () => {
    test('a stored file becomes a download link on the chat file route', () => {
        const url = storedFileArtifactUrl(BASE, 'flow-1', 'chat-1', 'FILE-STORAGE::harness_assets_1700000000000_0_q1-report.pdf')
        expect(url).toBe(
            `${BASE}/api/v1/get-upload-file?chatflowId=flow-1&chatId=chat-1&fileName=harness_assets_1700000000000_0_q1-report.pdf&download=true`
        )
        expect(storedFileArtifactUrl(BASE, 'flow-1', 'chat-1', 'data:text/csv;base64,YQ==')).toBe('data:text/csv;base64,YQ==')
    })

    test('only file types are file artifacts', () => {
        expect(['pdf', 'docx', 'xlsx', 'pptx', 'csv'].every((type) => isFileArtifact({ type }))).toBe(true)
        expect(isFileArtifact({ type: 'png' })).toBe(false)
        expect(isFileArtifact({ type: 'html' })).toBe(false)
        expect(isFileArtifact(null)).toBe(false)
    })

    test('only this server or a data URL of the same type is offered', () => {
        const stored = { type: 'pdf', data: `${BASE}/api/v1/get-upload-file?chatflowId=f&chatId=c&fileName=a.pdf&download=true` }
        expect(fileArtifactHref(stored, BASE)).toBe(stored.data)
        expect(fileArtifactHref({ type: 'csv', data: 'data:text/csv;base64,YSxiCg==' }, BASE)).toBe('data:text/csv;base64,YSxiCg==')
        expect(fileArtifactHref({ type: 'csv', data: 'data:text/html;base64,PGgxPg==' }, BASE)).toBeNull()
        expect(fileArtifactHref({ type: 'pdf', data: 'https://elsewhere.example/a.pdf' }, BASE)).toBeNull()
        expect(fileArtifactHref({ type: 'pdf', data: 'javascript:alert(1)' }, BASE)).toBeNull()
    })

    test('the download name comes from the artifact or the stored file name', () => {
        expect(fileArtifactName({ type: 'pdf', name: 'q1 report.pdf', data: '' })).toBe('q1_report.pdf')
        expect(
            fileArtifactName({
                type: 'csv',
                data: `${BASE}/api/v1/get-upload-file?chatflowId=f&chatId=c&fileName=harness_assets_17_1_orders.csv`
            })
        ).toBe('orders.csv')
        expect(fileArtifactName({ type: 'xlsx', data: 'data:application/x;base64,AA==' })).toBe('file.xlsx')
    })

    test('renders a download card with the file name and type', () => {
        const html = render({
            type: 'docx',
            name: 'memo.docx',
            data: `${BASE}/api/v1/get-upload-file?chatflowId=f&chatId=c&fileName=m.docx&download=true`
        })
        expect(html).toContain('data-testid="chat-file-artifact"')
        expect(html).toContain('download="memo.docx"')
        expect(html).toContain('aria-label="Download memo.docx"')
        expect(html).toContain('DOCX · Download')
    })

    test('a stored PPTX is offered as a download with its name', () => {
        const url = storedFileArtifactUrl(BASE, 'flow-1', 'chat-1', 'FILE-STORAGE::harness_assets_1700000000000_0_q3_deck.pptx')
        const item = { type: 'pptx', name: 'q3_deck.pptx', data: url }
        expect(fileArtifactHref(item, BASE)).toBe(url)
        const dataUrl = 'data:application/vnd.openxmlformats-officedocument.presentationml.presentation;base64,UEsDBA=='
        expect(fileArtifactHref({ type: 'pptx', data: dataUrl }, BASE)).toBe(dataUrl)
        expect(fileArtifactHref({ type: 'pptx', data: 'data:application/zip;base64,UEsDBA==' }, BASE)).toBeNull()
        const html = render(item)
        expect(html).toContain('download="q3_deck.pptx"')
        expect(html).toContain('PPTX · Download')
    })

    test('renders nothing for a link it does not offer', () => {
        expect(render({ type: 'pdf', name: 'a.pdf', data: 'https://elsewhere.example/a.pdf' })).toBe('')
    })

    test('the chat and the messages dialog render file artifacts and keep stored files on the file route', () => {
        const fs = require('fs')
        const path = require('path')
        for (const file of ['../../views/chatmessage/ChatMessage.jsx', '../dialog/ViewMessagesDialog.jsx']) {
            const source = fs.readFileSync(path.join(__dirname, file), 'utf8')
            expect(source).toContain('<FileArtifact key={index} item={item} />')
            expect(source).toContain('storedFileArtifactUrl(baseURL')
        }
    })
})
