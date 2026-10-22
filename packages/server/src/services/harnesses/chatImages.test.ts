import { artifactFileName, chatImages } from './chatImages'

describe('chatImages', () => {
    it('turns PNG and JPEG artifacts into data URLs, in order', () => {
        expect(
            chatImages([
                { type: 'png', mime: 'image/png', name: 'chart.png', specialist: 'analyst', base64: 'iVBO' },
                { type: 'jpeg', mime: 'image/jpeg', name: 'photo.jpg', specialist: 'analyst', base64: '/9j/' }
            ])
        ).toEqual([
            { type: 'png', data: 'data:image/png;base64,iVBO' },
            { type: 'jpeg', data: 'data:image/jpeg;base64,/9j/' }
        ])
    })

    it('turns PDF, DOCX, XLSX and CSV artifacts into named data URLs', () => {
        expect(
            chatImages([
                { type: 'pdf', mime: 'application/pdf', name: 'reports/q1 report.pdf', base64: 'JVBERi0=' },
                {
                    type: 'docx',
                    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                    name: 'memo.docx',
                    base64: 'UEsDBA=='
                },
                {
                    type: 'xlsx',
                    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                    name: 'table.xlsx',
                    base64: 'UEsDBA=='
                },
                { type: 'csv', mime: 'text/csv', name: 'orders.csv', base64: 'YSxiCg==' }
            ])
        ).toEqual([
            { type: 'pdf', data: 'data:application/pdf;base64,JVBERi0=', name: 'q1_report.pdf' },
            {
                type: 'docx',
                data: 'data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,UEsDBA==',
                name: 'memo.docx'
            },
            {
                type: 'xlsx',
                data: 'data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,UEsDBA==',
                name: 'table.xlsx'
            },
            { type: 'csv', data: 'data:text/csv;base64,YSxiCg==', name: 'orders.csv' }
        ])
    })

    it('skips anything that is not a known type with bytes', () => {
        expect(chatImages(undefined)).toEqual([])
        expect(chatImages('chart.png')).toEqual([])
        expect(
            chatImages([
                { type: 'png', mime: 'image/png', name: 'names-only.png' },
                { type: 'svg', mime: 'image/svg+xml', base64: 'PHN2Zz4=' },
                { type: 'html', mime: 'text/html', name: 'page.html', base64: 'PGgxPg==' },
                { type: 'pdf', mime: 'text/csv', name: 'mismatch.pdf', base64: 'JVBERi0=' },
                { type: 'csv', mime: 'text/csv', name: 'bad.csv', base64: 'not base64!' },
                null
            ])
        ).toEqual([])
    })

    it('keeps a safe file name', () => {
        expect(artifactFileName('../../etc/passwd.csv', 'csv')).toBe('passwd.csv')
        expect(artifactFileName('...', 'pdf')).toBe('file.pdf')
        expect(artifactFileName(undefined, 'xlsx')).toBe('file.xlsx')
    })
})
