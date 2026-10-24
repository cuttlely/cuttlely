import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Preset specialists: a Harness Specialist with Preset set to a name here gets that preset's tools, routing summary
// and instructions, plus any kit files in its working directory. Its own Instructions are added after the preset's.
const HERE = path.dirname(fileURLToPath(import.meta.url))

export const ASSETS_KIT_FILE = 'cuttlely_assets.py'
export const ASSETS_KIT_SOURCE = path.join(HERE, 'presets', 'assets', ASSETS_KIT_FILE)
// The download helper the kit uses, and the older asset_kit name so `from asset_kit import use_dir` keeps working.
export const ASSETS_FETCH_SOURCE = path.join(HERE, 'presets', 'assets', 'cuttlely_fetch.py')
export const ASSETS_KIT_ALIAS_SOURCE = path.join(HERE, 'presets', 'assets', 'asset_kit.py')

const ASSETS_INSTRUCTIONS = [
    'You make polished files: PNG charts, PDF reports, DOCX documents, XLSX workbooks and CSV tables.',
    `Use the style kit in your working directory (${ASSETS_KIT_FILE}) so every file shares one palette, the same fonts, and the same table and chart themes:`,
    '  import sys, os; sys.path.insert(0, os.getcwd()); import cuttlely_assets as kit',
    '  kit.apply_chart_theme(); fig, ax = kit.bar_chart(labels, values, title=...); kit.save_png(fig, path)',
    '  kit.pdf_report(path, title, [kit.Heading(...), kit.Text(...), kit.Table(rows), kit.Image(png_path)])',
    '  kit.docx_report(path, title, blocks); kit.xlsx_table(path, rows, sheet=...); kit.csv_table(path, rows)',
    '  out = kit.use_dir(folder); kit.fetch_asset(url, out / "logo.svg")',
    'Download logos and images only with kit.fetch_asset(url, path) (or kit.fetch(url) for other files). Do not use urllib or requests directly.',
    'For logos, prefer Wikimedia Commons, https://commons.wikimedia.org/wiki/Special:FilePath/<File name>.svg, or the official press kit or brand page.',
    'An asset is in a file only when fetch_asset printed "saved <name>: <n> bytes". Never say a logo or image was embedded otherwise.',
    'When a download fails, say plainly which asset, the URL and the error, and leave it out or use a text label instead.',
    'kit.PALETTE, kit.SERIES, kit.FONTS, kit.CHART_THEME and kit.TABLE_THEME hold the style values for anything the helpers do not cover.',
    'Save every file for the chat in the folder the task names, with a short lowercase name such as q1-report.pdf.',
    'Use only the data in the task or from earlier specialists. Do not invent figures.',
    'In your answer, name each file you saved and say in one line what it holds.'
].join('\n')

export const SPECIALIST_PRESETS = {
    assets: {
        name: 'assets',
        summary: 'Makes polished files for the chat: PNG charts, PDF reports, DOCX documents, XLSX workbooks and CSV tables.',
        instructions: ASSETS_INSTRUCTIONS,
        codeExecution: true,
        fileAccess: true,
        kit: [ASSETS_KIT_SOURCE, ASSETS_FETCH_SOURCE, ASSETS_KIT_ALIAS_SOURCE]
    }
}

export function presetName(value) {
    const name = typeof value === 'string' ? value.trim().toLowerCase() : ''
    return Object.hasOwn(SPECIALIST_PRESETS, name) ? name : ''
}

// The saved record keeps the specialist's own Instructions and Routing summary. The preset's tools are switched on
// at save (normalizePresetSpecialist); its instructions and summary are added when the profile and the routing
// prompt are written (presetInstructions, presetSummary), so a later Cuttlely release can improve them.
export function normalizePresetSpecialist(specialist) {
    if (!specialist || typeof specialist !== 'object') return specialist
    const name = presetName(specialist.preset)
    if (!name) {
        delete specialist.preset
        return specialist
    }
    const preset = SPECIALIST_PRESETS[name]
    specialist.preset = name
    if (!specialist.name) specialist.name = preset.name
    if (preset.codeExecution) specialist.codeExecution = true
    if (preset.fileAccess) specialist.fileAccess = true
    return specialist
}

export function presetInstructions(specialist) {
    const own = typeof specialist?.instructions === 'string' ? specialist.instructions.trim() : ''
    const name = presetName(specialist?.preset)
    if (!name) return own
    const preset = SPECIALIST_PRESETS[name].instructions
    return own ? `${preset}\n\n${own}` : preset
}

export function presetSummary(specialist) {
    const name = presetName(specialist?.preset)
    return name ? SPECIALIST_PRESETS[name].summary : ''
}

// Copies the preset's kit files into the specialist's working directory. A file that is already the same is left.
export function installPresetKit(specialist, workspace) {
    const name = presetName(specialist?.preset)
    if (!name || !workspace) return []
    const written = []
    for (const source of SPECIALIST_PRESETS[name].kit || []) {
        const target = path.join(workspace, path.basename(source))
        const text = fs.readFileSync(source, 'utf8')
        let current = null
        try {
            current = fs.readFileSync(target, 'utf8')
        } catch {
            // not there yet
        }
        if (current !== text) fs.writeFileSync(target, text)
        written.push(target)
    }
    return written
}
