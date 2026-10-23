#!/usr/bin/env node
/* eslint-disable no-console -- build script; output is the interface */
// Writes website/public/social/og-light.png (1200x630) from brand assets and the production headline.
// Run from website/: `node scripts/generate-og.mjs`
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import sharp from 'sharp'

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO = path.resolve(SITE, '..')
const WIDTH = 1200
const HEIGHT = 630
const OUT = path.join(SITE, 'public', 'social', 'og-light.png')
const HEADLINE = 'Your applications'
const HEADLINE_ACCENT = 'deserve agents'
const SUBLINE = 'Context-aware agent orchestration. Open source, Apache-2.0.'

function fontFace(fontFile, family) {
    const abs = path.resolve(fontFile).split(path.sep).join('/')
    const format = abs.endsWith('.woff2') ? 'woff2' : abs.endsWith('.woff') ? 'woff' : 'truetype'
    return `@font-face { font-family: '${family}'; src: url('file://${abs}') format('${format}'); font-weight: 700 800; font-style: normal; }`
}

function pickFont() {
    const urbanist = path.join(SITE, 'public', 'fonts', 'Urbanist-latin-VariableFont_wght.woff2')
    const inter = '/usr/share/fonts/truetype/macos/Inter-Bold.ttf'
    const dejavu = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
    if (fs.existsSync(urbanist)) return { file: urbanist, family: 'Urbanist' }
    if (fs.existsSync(inter)) return { file: inter, family: 'Inter' }
    if (fs.existsSync(dejavu)) return { file: dejavu, family: 'DejaVu Sans' }
    return { file: null, family: 'sans-serif' }
}

export async function renderOg({ out = OUT } = {}) {
    const logoPath = path.join(REPO, 'assets', 'brand', 'logo', 'cuttlely-logo-horizontal.svg')
    const mascotPath = path.join(SITE, 'src', 'assets', 'cuttlely-mascot-primary-1024.webp')
    if (!fs.existsSync(logoPath)) throw new Error(`missing logo: ${logoPath}`)
    if (!fs.existsSync(mascotPath)) throw new Error(`missing mascot: ${mascotPath}`)

    const font = pickFont()
    const face = font.file ? fontFace(font.file, font.family) : ''
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlely-og-'))
    const logoPng = path.join(tmp, 'logo.png')
    const mascotPng = path.join(tmp, 'mascot.png')

    await sharp(logoPath).resize({ width: 280, withoutEnlargement: true }).png().toFile(logoPng)
    await sharp(mascotPath).resize({ width: 520, withoutEnlargement: true }).png().toFile(mascotPng)

    const subFirst = 'Context-aware agent orchestration.'
    const subSecond = 'Open source, Apache-2.0.'
    if (`${subFirst} ${subSecond}` !== SUBLINE) throw new Error('og subline wrap must match the approved line')
    const textSvgWrapped = Buffer.from(
        `<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#F8F5FF"/>
      <stop offset="55%" stop-color="#F5F8FE"/>
      <stop offset="100%" stop-color="#EAF1FF"/>
    </linearGradient>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#6A3DF2"/>
      <stop offset="100%" stop-color="#3B4FE0"/>
    </linearGradient>
  </defs>
  <style>
    ${face}
    .ink { font-family: '${font.family}', sans-serif; font-weight: 800; fill: #0A0D1E; }
    .accent { font-family: '${font.family}', sans-serif; font-weight: 800; fill: url(#accent); }
    .sub { font-family: '${font.family}', sans-serif; font-weight: 600; fill: #4A5578; }
  </style>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>
  <text x="72" y="310" class="ink" font-size="52">${HEADLINE}</text>
  <text x="72" y="378" class="accent" font-size="52">${HEADLINE_ACCENT}</text>
  <text x="72" y="450" class="sub" font-size="26">${subFirst}</text>
  <text x="72" y="490" class="sub" font-size="26">${subSecond}</text>
</svg>`
    )

    const background = await sharp(textSvgWrapped).png().toBuffer()
    const logo = await sharp(logoPng).toBuffer()
    const mascot = await sharp(mascotPng).toBuffer()
    const mascotMeta = await sharp(mascot).metadata()
    const mascotLeft = WIDTH - (mascotMeta.width || 520) + 20
    const mascotTop = Math.round((HEIGHT - (mascotMeta.height || 520)) / 2)

    await sharp(background)
        .composite([
            { input: logo, left: 72, top: 72 },
            { input: mascot, left: mascotLeft, top: mascotTop }
        ])
        .png({ compressionLevel: 9, palette: false })
        .toFile(out)

    fs.rmSync(tmp, { recursive: true, force: true })
    const bytes = fs.statSync(out).size
    if (bytes > 300 * 1024) throw new Error(`og image is ${bytes} bytes, need under 300 KB`)
    return { out, bytes, width: WIDTH, height: HEIGHT, font: font.family }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const result = await renderOg()
    console.log(`generate-og: wrote ${result.out} (${result.bytes} bytes, ${result.width}x${result.height}, font ${result.font})`)
}
