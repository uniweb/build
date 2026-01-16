/**
 * Advanced Asset Processors
 *
 * Optional processors for advanced asset types:
 * - Video poster extraction (requires ffmpeg)
 * - PDF thumbnail generation (requires pdf-lib)
 *
 * These features gracefully degrade if dependencies aren't available.
 *
 * @module @uniweb/build/site
 */

import { spawn } from 'node:child_process'
import { writeFile, mkdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname, basename, extname } from 'node:path'
import { createHash } from 'node:crypto'
import sharp from 'sharp'

// Video extensions we can extract posters from
const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.avi', '.mkv']

// Check if a file is a video
export function isVideoFile(filePath) {
  const ext = extname(filePath).toLowerCase()
  return VIDEO_EXTENSIONS.includes(ext)
}

// Check if a file is a PDF
export function isPdfFile(filePath) {
  return extname(filePath).toLowerCase() === '.pdf'
}

/**
 * Check if ffmpeg is available on the system
 */
let ffmpegAvailable = null
export async function checkFfmpeg() {
  if (ffmpegAvailable !== null) return ffmpegAvailable

  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', ['-version'], { stdio: 'ignore' })
    proc.on('error', () => {
      ffmpegAvailable = false
      resolve(false)
    })
    proc.on('close', (code) => {
      ffmpegAvailable = code === 0
      resolve(ffmpegAvailable)
    })
  })
}

/**
 * Extract a poster frame from a video using ffmpeg
 *
 * @param {string} videoPath - Path to the video file
 * @param {string} outputPath - Path for the output image
 * @param {Object} options - Extraction options
 * @returns {Promise<Object>} Result with success status and output path
 */
export async function extractVideoPoster(videoPath, outputPath, options = {}) {
  const {
    timestamp = '00:00:01', // Default to 1 second in
    width = 1280,           // Max width
    quality = 80            // WebP quality
  } = options

  // Check if ffmpeg is available
  const hasFFmpeg = await checkFfmpeg()
  if (!hasFFmpeg) {
    return {
      success: false,
      error: 'ffmpeg not available',
      skipped: true
    }
  }

  // Check if video exists
  if (!existsSync(videoPath)) {
    return {
      success: false,
      error: 'Video file not found'
    }
  }

  // Ensure output directory exists
  await mkdir(dirname(outputPath), { recursive: true })

  // Temporary file for raw frame
  const tempPath = outputPath.replace(/\.[^.]+$/, '.tmp.png')

  return new Promise((resolve) => {
    // Extract frame with ffmpeg
    const args = [
      '-ss', timestamp,
      '-i', videoPath,
      '-vframes', '1',
      '-vf', `scale='min(${width},iw)':-1`,
      '-y',
      tempPath
    ]

    const proc = spawn('ffmpeg', args, { stdio: 'pipe' })

    let stderr = ''
    proc.stderr?.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('error', (err) => {
      resolve({
        success: false,
        error: `ffmpeg error: ${err.message}`
      })
    })

    proc.on('close', async (code) => {
      if (code !== 0 || !existsSync(tempPath)) {
        resolve({
          success: false,
          error: `ffmpeg failed with code ${code}`
        })
        return
      }

      try {
        // Convert to WebP for optimization
        await sharp(tempPath)
          .webp({ quality })
          .toFile(outputPath)

        // Clean up temp file
        const fs = await import('node:fs/promises')
        await fs.unlink(tempPath).catch(() => {})

        resolve({
          success: true,
          outputPath,
          type: 'webp'
        })
      } catch (err) {
        resolve({
          success: false,
          error: `Failed to convert poster: ${err.message}`
        })
      }
    })
  })
}

/**
 * Generate a thumbnail from a PDF's first page
 *
 * Uses pdf-lib to extract the first page dimensions and sharp to render.
 * Falls back gracefully if pdf-lib is not available.
 *
 * @param {string} pdfPath - Path to the PDF file
 * @param {string} outputPath - Path for the output image
 * @param {Object} options - Generation options
 * @returns {Promise<Object>} Result with success status and output path
 */
export async function generatePdfThumbnail(pdfPath, outputPath, options = {}) {
  const {
    width = 800,
    quality = 80,
    page = 0 // First page
  } = options

  // Check if PDF exists
  if (!existsSync(pdfPath)) {
    return {
      success: false,
      error: 'PDF file not found'
    }
  }

  try {
    // Try to import pdf-lib dynamically
    let PDFDocument
    try {
      const pdfLib = await import('pdf-lib')
      PDFDocument = pdfLib.PDFDocument
    } catch {
      return {
        success: false,
        error: 'pdf-lib not available',
        skipped: true
      }
    }

    // Load the PDF
    const pdfBytes = await readFile(pdfPath)
    const pdfDoc = await PDFDocument.load(pdfBytes)

    const pages = pdfDoc.getPages()
    if (pages.length === 0) {
      return {
        success: false,
        error: 'PDF has no pages'
      }
    }

    const firstPage = pages[page] || pages[0]
    const { width: pdfWidth, height: pdfHeight } = firstPage.getSize()

    // Calculate dimensions maintaining aspect ratio
    const aspectRatio = pdfHeight / pdfWidth
    const outputWidth = Math.min(width, pdfWidth)
    const outputHeight = Math.round(outputWidth * aspectRatio)

    // Create a placeholder thumbnail with PDF info
    // Note: Full PDF rendering would require additional dependencies like pdf2pic or puppeteer
    // For now, we create a styled placeholder that indicates it's a PDF
    const svg = `
      <svg width="${outputWidth}" height="${outputHeight}" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="bg" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" style="stop-color:#f8f9fa"/>
            <stop offset="100%" style="stop-color:#e9ecef"/>
          </linearGradient>
        </defs>
        <rect width="100%" height="100%" fill="url(#bg)"/>
        <rect x="10" y="10" width="${outputWidth - 20}" height="${outputHeight - 20}"
              fill="white" stroke="#dee2e6" stroke-width="1" rx="4"/>
        <text x="50%" y="45%" text-anchor="middle" font-family="system-ui, sans-serif"
              font-size="48" fill="#6c757d">PDF</text>
        <text x="50%" y="60%" text-anchor="middle" font-family="system-ui, sans-serif"
              font-size="14" fill="#adb5bd">${pages.length} page${pages.length > 1 ? 's' : ''}</text>
      </svg>
    `

    // Ensure output directory exists
    await mkdir(dirname(outputPath), { recursive: true })

    // Convert SVG to WebP
    await sharp(Buffer.from(svg))
      .webp({ quality })
      .toFile(outputPath)

    return {
      success: true,
      outputPath,
      type: 'webp',
      pageCount: pages.length,
      placeholder: true // Indicates this is a placeholder, not a true render
    }
  } catch (err) {
    return {
      success: false,
      error: `PDF processing failed: ${err.message}`
    }
  }
}

/**
 * Process a video or PDF asset, generating appropriate thumbnails
 *
 * @param {Object} asset - Asset info
 * @param {Object} options - Processing options
 * @returns {Promise<Object>} Processing result with poster/thumbnail info
 */
export async function processAdvancedAsset(asset, options = {}) {
  const {
    outputDir,
    assetsSubdir = 'assets',
    videoPosters = true,
    pdfThumbnails = true,
    quality = 80
  } = options

  const { resolved } = asset

  if (!existsSync(resolved)) {
    return { processed: false, error: 'File not found' }
  }

  const ext = extname(resolved).toLowerCase()
  const name = basename(resolved, ext)

  // Generate content hash for cache busting
  const content = await readFile(resolved)
  const hash = createHash('md5').update(content).digest('hex').slice(0, 8)

  // Handle video files
  if (isVideoFile(resolved) && videoPosters) {
    const posterFilename = `${name}-poster-${hash}.webp`
    const posterPath = join(outputDir, assetsSubdir, posterFilename)

    const result = await extractVideoPoster(resolved, posterPath, { quality })

    if (result.success) {
      return {
        processed: true,
        type: 'video',
        poster: `/${assetsSubdir}/${posterFilename}`
      }
    } else if (result.skipped) {
      // ffmpeg not available - not an error, just skip
      return { processed: false, skipped: true, reason: result.error }
    } else {
      return { processed: false, error: result.error }
    }
  }

  // Handle PDF files
  if (isPdfFile(resolved) && pdfThumbnails) {
    const thumbFilename = `${name}-thumb-${hash}.webp`
    const thumbPath = join(outputDir, assetsSubdir, thumbFilename)

    const result = await generatePdfThumbnail(resolved, thumbPath, { quality })

    if (result.success) {
      return {
        processed: true,
        type: 'pdf',
        thumbnail: `/${assetsSubdir}/${thumbFilename}`,
        pageCount: result.pageCount,
        placeholder: result.placeholder
      }
    } else if (result.skipped) {
      // pdf-lib not available - not an error, just skip
      return { processed: false, skipped: true, reason: result.error }
    } else {
      return { processed: false, error: result.error }
    }
  }

  // Not a video or PDF, or processing disabled
  return { processed: false, skipped: true, reason: 'Not an advanced asset type' }
}

/**
 * Process all advanced assets in a manifest
 *
 * @param {Object} assetManifest - Asset manifest
 * @param {Object} options - Processing options
 * @param {Set} [options.hasExplicitPoster] - Set of video paths with explicit poster attributes
 * @param {Set} [options.hasExplicitPreview] - Set of PDF paths with explicit preview attributes
 * @returns {Promise<Object>} Results with poster/thumbnail mappings
 */
export async function processAdvancedAssets(assetManifest, options = {}) {
  const {
    hasExplicitPoster = new Set(),
    hasExplicitPreview = new Set(),
    ...processingOptions
  } = options

  const posterMapping = {}  // video src -> poster url
  const thumbnailMapping = {} // pdf src -> thumbnail url
  const results = {
    videos: { processed: 0, skipped: 0, explicit: 0 },
    pdfs: { processed: 0, skipped: 0, explicit: 0 }
  }

  for (const [originalPath, asset] of Object.entries(assetManifest)) {
    if (isVideoFile(asset.resolved || '')) {
      // Skip auto-generation if explicit poster was provided
      if (hasExplicitPoster.has(originalPath)) {
        results.videos.explicit++
        continue
      }

      const result = await processAdvancedAsset(asset, processingOptions)
      if (result.processed && result.poster) {
        posterMapping[originalPath] = result.poster
        results.videos.processed++
      } else {
        results.videos.skipped++
      }
    } else if (isPdfFile(asset.resolved || '')) {
      // Skip auto-generation if explicit preview was provided
      if (hasExplicitPreview.has(originalPath)) {
        results.pdfs.explicit++
        continue
      }

      const result = await processAdvancedAsset(asset, processingOptions)
      if (result.processed && result.thumbnail) {
        thumbnailMapping[originalPath] = {
          url: result.thumbnail,
          pageCount: result.pageCount,
          placeholder: result.placeholder
        }
        results.pdfs.processed++
      } else {
        results.pdfs.skipped++
      }
    }
  }

  return { posterMapping, thumbnailMapping, results }
}
