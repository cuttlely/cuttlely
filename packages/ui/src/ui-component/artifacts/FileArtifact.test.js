jest.mock('@/store/constant', () => ({ baseURL: 'https://cuttlely.example' }))

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import FileArtifact from './FileArtifact'
import ImageDownloadButton from './ImageDownloadButton'
import { fileArtifactHref, fileArtifactName, imageArtifactDownload, isFileArtifact, storedFileArtifactUrl } from '@/utils/chatArtifacts'

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
        expect(['pdf', 'docx', 'xlsx', 'csv'].every((type) => isFileArtifact({ type }))).toBe(true)
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

    test('a chat image downloads from the file route with download=true and its stored name', () => {
        const url = `${BASE}/api/v1/get-upload-file?chatflowId=f&chatId=c&fileName=harness_assets_1700000000000_0_sales-chart.png`
        expect(imageArtifactDownload({ type: 'png', data: url }, BASE)).toEqual({ href: `${url}&download=true`, name: 'sales-chart.png' })
        expect(imageArtifactDownload({ type: 'png', data: `${url}&download=true` }, BASE).href).toBe(`${url}&download=true`)
        expect(imageArtifactDownload({ type: 'jpeg', name: 'photo', data: url.replace('.png', '.jpg') }, BASE).name).toBe('photo.jpg')
        expect(imageArtifactDownload({ type: 'png', data: 'data:image/png;base64,iVBORw0KGgo=' }, BASE)).toEqual({
            href: 'data:image/png;base64,iVBORw0KGgo=',
            name: 'file.png'
        })
    })

    test('a stored name with a stray percent sign does not throw', () => {
        const url = `${BASE}/api/v1/get-upload-file?chatflowId=f&chatId=c&fileName=chart%complete.png`
        expect(imageArtifactDownload({ type: 'png', data: url }, BASE).name).toBe('chart_complete.png')
        expect(fileArtifactName({ type: 'csv', data: `${BASE}/api/v1/get-upload-file?fileName=a%zz.csv` })).toBe('a_zz.csv')
    })

    test('a chat image from elsewhere or of another type has no download', () => {
        expect(imageArtifactDownload({ type: 'png', data: 'https://elsewhere.example/a.png' }, BASE)).toBeNull()
        expect(imageArtifactDownload({ type: 'png', data: 'data:image/svg+xml;base64,PHN2Zz4=' }, BASE)).toBeNull()
        expect(imageArtifactDownload({ type: 'jpeg', data: 'data:image/png;base64,iVBORw0KGgo=' }, BASE)).toBeNull()
        expect(imageArtifactDownload({ type: 'html', data: `${BASE}/api/v1/get-upload-file?fileName=a.html` }, BASE)).toBeNull()
        expect(imageArtifactDownload(null, BASE)).toBeNull()
    })

    test('renders a download button for a chat image and nothing for one it does not offer', () => {
        const draw = (item) =>
            renderToStaticMarkup(createElement(ThemeProvider, { theme: createTheme() }, createElement(ImageDownloadButton, { item })))
        const html = draw({ type: 'png', data: `${BASE}/api/v1/get-upload-file?chatflowId=f&chatId=c&fileName=harness_a_1_0_chart.png` })
        expect(html).toContain('data-testid="chat-image-download"')
        expect(html).toContain('download="chart.png"')
        expect(html).toContain('aria-label="Download chart.png"')
        expect(html).toContain('fileName=harness_a_1_0_chart.png&amp;download=true')
        expect(draw({ type: 'png', data: 'https://elsewhere.example/a.png' })).toBe('')
    })

    test('the chat and the messages dialog put the download button on image cards', () => {
        const fs = require('fs')
        const path = require('path')
        for (const file of ['../../views/chatmessage/ChatMessage.jsx', '../dialog/ViewMessagesDialog.jsx']) {
            const source = fs.readFileSync(path.join(__dirname, file), 'utf8')
            expect(source).toContain('<ImageDownloadButton item={item} />')
        }
    })
})
