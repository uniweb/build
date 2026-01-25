#!/usr/bin/env node
/**
 * Generate HTML comparison of color shade generation modes
 *
 * Usage: node scripts/test-color-modes.js
 * Output: Opens color-modes-test.html in browser
 */

import { generateShades, getAvailableModes, getShadeLevels } from '../src/theme/shade-generator.js'
import { writeFileSync } from 'fs'
import { exec } from 'child_process'

// Test colors covering different hue ranges
const testColors = [
  { name: 'Blue', hex: '#3b82f6' },
  { name: 'Red', hex: '#ef4444' },
  { name: 'Green', hex: '#22c55e' },
  { name: 'Orange', hex: '#f97316' },
  { name: 'Purple', hex: '#a855f7' },
  { name: 'Teal', hex: '#14b8a6' },
  { name: 'Pink', hex: '#ec4899' },
  { name: 'Slate', hex: '#64748b' },
]

const modes = getAvailableModes()
const levels = getShadeLevels()

function generateHTML() {
  let html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Color Shade Generation Modes</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f8fafc;
      padding: 2rem;
      color: #1e293b;
    }
    h1 {
      text-align: center;
      margin-bottom: 0.5rem;
      font-size: 1.75rem;
    }
    .subtitle {
      text-align: center;
      color: #64748b;
      margin-bottom: 2rem;
      font-size: 0.875rem;
    }
    .color-section {
      margin-bottom: 3rem;
      background: white;
      border-radius: 12px;
      padding: 1.5rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    .color-header {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 1rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid #e2e8f0;
    }
    .color-swatch-header {
      width: 2rem;
      height: 2rem;
      border-radius: 6px;
      border: 2px solid rgba(0,0,0,0.1);
    }
    .color-name {
      font-weight: 600;
      font-size: 1.125rem;
    }
    .color-hex {
      color: #64748b;
      font-family: monospace;
      font-size: 0.875rem;
    }
    .modes-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 1.5rem;
    }
    .mode-card {
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      overflow: hidden;
    }
    .mode-header {
      background: #f1f5f9;
      padding: 0.75rem 1rem;
      font-weight: 600;
      font-size: 0.875rem;
      text-transform: capitalize;
      border-bottom: 1px solid #e2e8f0;
    }
    .mode-header span {
      font-weight: 400;
      color: #64748b;
      font-size: 0.75rem;
      margin-left: 0.5rem;
    }
    .shades {
      display: flex;
      flex-direction: column;
    }
    .shade {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 0.75rem;
      height: 2.25rem;
      font-size: 0.75rem;
      font-family: monospace;
      transition: transform 0.1s;
    }
    .shade:hover {
      transform: scale(1.02);
      z-index: 1;
      box-shadow: 0 2px 8px rgba(0,0,0,0.15);
    }
    .shade-level {
      font-weight: 600;
      min-width: 2.5rem;
    }
    .shade-value {
      opacity: 0.8;
    }
    .shade.base {
      height: 2.75rem;
      font-weight: 700;
    }
    .base-indicator {
      font-size: 0.625rem;
      background: rgba(255,255,255,0.3);
      padding: 0.125rem 0.375rem;
      border-radius: 3px;
      margin-left: 0.5rem;
    }
    .legend {
      display: flex;
      gap: 2rem;
      justify-content: center;
      margin-bottom: 2rem;
      flex-wrap: wrap;
    }
    .legend-item {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.875rem;
    }
    .legend-dot {
      width: 12px;
      height: 12px;
      border-radius: 50%;
    }
    .comparison-note {
      text-align: center;
      color: #64748b;
      font-size: 0.75rem;
      margin-top: 1rem;
      padding-top: 1rem;
      border-top: 1px solid #e2e8f0;
    }
  </style>
</head>
<body>
  <h1>Color Shade Generation Modes</h1>
  <p class="subtitle">Comparing fixed, natural, and vivid algorithms across different base colors</p>

  <div class="legend">
    <div class="legend-item">
      <div class="legend-dot" style="background: #3b82f6"></div>
      <span><strong>Fixed:</strong> Constant hue, predictable lightness</span>
    </div>
    <div class="legend-item">
      <div class="legend-dot" style="background: #22c55e"></div>
      <span><strong>Natural:</strong> Temperature-aware hue shifts</span>
    </div>
    <div class="legend-item">
      <div class="legend-dot" style="background: #f97316"></div>
      <span><strong>Vivid:</strong> Higher saturation, dramatic curves</span>
    </div>
  </div>
`

  for (const color of testColors) {
    html += `
  <div class="color-section">
    <div class="color-header">
      <div class="color-swatch-header" style="background: ${color.hex}"></div>
      <span class="color-name">${color.name}</span>
      <span class="color-hex">${color.hex}</span>
    </div>
    <div class="modes-grid">
`

    for (const mode of modes) {
      const shades = generateShades(color.hex, { mode, format: 'hex' })
      const modeDesc = mode === 'fixed' ? 'constant hue' : mode === 'natural' ? 'hue shifts' : 'high chroma'

      html += `
      <div class="mode-card">
        <div class="mode-header">${mode}<span>${modeDesc}</span></div>
        <div class="shades">
`

      for (const level of levels) {
        const hex = shades[level]
        const isBase = level === 500
        const textColor = level >= 500 ? '#ffffff' : '#000000'

        html += `          <div class="shade${isBase ? ' base' : ''}" style="background: ${hex}; color: ${textColor}">
            <span class="shade-level">${level}${isBase ? '<span class="base-indicator">BASE</span>' : ''}</span>
            <span class="shade-value">${hex}</span>
          </div>
`
      }

      html += `        </div>
      </div>
`
    }

    html += `    </div>
    <p class="comparison-note">Hover over shades to compare. Notice hue shifts in natural/vivid modes at extremes.</p>
  </div>
`
  }

  html += `</body>
</html>`

  return html
}

// Generate and write HTML
const html = generateHTML()
const outputPath = new URL('../color-modes-test.html', import.meta.url).pathname

writeFileSync(outputPath, html)
console.log(`Generated: ${outputPath}`)

// Open in browser
const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
exec(`${openCmd} "${outputPath}"`, (err) => {
  if (err) {
    console.log('Could not open browser automatically. Please open the file manually.')
  }
})
