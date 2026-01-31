# @uniweb/build

Build tooling for the Uniweb Component Web Platform.

## Overview

This package provides Vite plugins and utilities for building both **Foundations** (component libraries) and **Sites** (content-driven websites).

## Installation

```bash
npm install @uniweb/build --save-dev
```

## Features

**For Foundations:**
- **Component Discovery** - Discovers section types from `src/sections/` (implicit at root) and `src/components/` (requires `meta.js`)
- **Entry Generation** - Generates the foundation entry point with all exports
- **Schema Building** - Creates `schema.json` with full component metadata for editors
- **Image Processing** - Converts preview images to WebP format
- **Vite Plugin** - Integrates seamlessly with Vite builds

**For Sites:**
- **Content Collection** - Collects pages from `pages/` directory with YAML/Markdown
- **Dev Server Integration** - Watches for content changes with hot reload
- **Foundation Dev Server** - Serves a local foundation during development

## Usage

### Foundation Plugin

Add the foundation plugin to your foundation's `vite.config.js`:

```js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { foundationPlugin } from '@uniweb/build'

export default defineConfig({
  plugins: [
    react(),
    foundationPlugin()
  ],
  build: {
    lib: {
      entry: 'src/_entry.generated.js',
      formats: ['es'],
      fileName: 'foundation'
    },
    rollupOptions: {
      external: ['react', 'react-dom', 'react/jsx-runtime']
    }
  }
})
```

### Site Plugins

For sites, use the content and dev plugins in your site's `vite.config.js`:

```js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { siteContentPlugin } from '@uniweb/build/site'
import { foundationDevPlugin } from '@uniweb/build/dev'

export default defineConfig({
  plugins: [
    react(),

    // Collect content from pages/ directory
    siteContentPlugin({
      sitePath: './',
      inject: true,  // Inject into HTML
    }),

    // Serve local foundation during development
    foundationDevPlugin({
      path: '../foundation',
      serve: '/foundation',
    }),
  ]
})
```

#### Site Content Plugin Options

```js
siteContentPlugin({
  sitePath: './',              // Path to site directory
  pagesDir: 'pages',           // Pages subdirectory name
  inject: true,                // Inject content into HTML
  filename: 'site-content.json', // Output filename
  watch: true,                 // Watch for changes (dev mode)
  seo: {                       // SEO configuration (optional)
    baseUrl: 'https://example.com',
    defaultImage: '/og-image.png',
    twitterHandle: '@example',
    locales: [
      { code: 'en', default: true },
      { code: 'es' }
    ],
    robots: {
      disallow: ['/admin', '/api'],
      crawlDelay: 1
    }
  },
  assets: {                    // Asset processing (optional)
    process: true,             // Process assets in production (default: true)
    convertToWebp: true,       // Convert images to WebP (default: true)
    quality: 80,               // WebP quality 1-100 (default: 80)
    outputDir: 'assets',       // Output subdirectory (default: 'assets')
    videoPosters: true,        // Extract poster from videos (default: true, requires ffmpeg)
    pdfThumbnails: true        // Generate PDF thumbnails (default: true, requires pdf-lib)
  }
})
```

#### SEO Features

When `seo.baseUrl` is provided, the plugin generates:

**sitemap.xml** - Auto-generated from collected pages with:
- Last modified dates from file timestamps
- Per-page `changefreq` and `priority` from page frontmatter
- Hreflang entries for multi-locale sites

**robots.txt** - Generated with sitemap reference and optional rules

**Meta Tags** - Injected into HTML `<head>`:
- Open Graph tags (`og:title`, `og:description`, `og:image`, etc.)
- Twitter Card tags (`twitter:card`, `twitter:site`, etc.)
- Canonical URL
- Hreflang links for multi-locale sites

**Page-level SEO** - Configure in `page.yml`:
```yaml
title: About Us
description: Learn about our company
seo:
  noindex: false          # Exclude from sitemap
  image: /about-og.png    # Page-specific OG image
  changefreq: monthly     # Sitemap changefreq
  priority: 0.8           # Sitemap priority
```

#### Asset Processing

The plugin automatically discovers and processes assets referenced in your content. In content-driven sites, markdown acts as "code" - local asset references are like implicit imports and get optimized during build.

**Supported path formats:**
- `./image.png` - Relative to the markdown file
- `../shared/logo.png` - Relative paths with parent traversal
- `/images/hero.png` - Absolute paths (resolved from `public/` or `assets/` folder)

**What gets processed:**
- Images in markdown content: `![Alt](./photo.jpg)`
- Media in frontmatter fields: `background`, `image`, `thumbnail`, `poster`, `avatar`, `logo`, `icon`, `video`, `pdf`, etc.

**Image processing:**
- PNG, JPG, JPEG, GIF → Converted to WebP for smaller file sizes
- SVG, WebP, AVIF → Copied as-is (already optimized formats)
- All processed assets get content-hashed filenames for cache busting

**Video poster extraction** (requires `ffmpeg` on system):
- MP4, WebM, MOV, AVI, MKV → Poster frame extracted at 1 second
- Poster images converted to WebP and added to `_assetMeta.posters`
- Skipped if an explicit `poster` attribute is provided in markdown

**PDF thumbnail generation** (requires `pdf-lib` package):
- PDF files → Placeholder thumbnail with page count
- Thumbnails added to `_assetMeta.thumbnails`
- Skipped if an explicit `preview` attribute is provided in markdown

**Explicit poster/preview images:**

When you provide explicit `poster` or `preview` attributes in your markdown, those images are collected and optimized alongside other assets:

```markdown
![Video](./intro.mp4){role=video poster=./custom-poster.jpg}
![PDF](./guide.pdf){role=pdf preview=./guide-preview.png}
```

- The explicit images (`./custom-poster.jpg`, `./guide-preview.png`) are processed and optimized
- Auto-generation via ffmpeg/pdf-lib is skipped for these files
- This gives you full control over preview images while still benefiting from optimization

**Build output:**
```
dist/
├── assets/
│   ├── hero-a1b2c3d4.webp       # Converted from hero.jpg
│   ├── logo-e5f6g7h8.svg        # Copied as-is
│   ├── intro-poster-9i0j1k2l.webp  # Video poster frame
│   └── guide-thumb-3m4n5o6p.webp   # PDF thumbnail
└── site-content.json             # Paths rewritten, _assetMeta included
```

**Graceful degradation:**
- If `ffmpeg` is not installed, video posters are silently skipped
- If `pdf-lib` is not installed, PDF thumbnails are silently skipped
- Missing assets are logged as warnings but don't fail the build

#### Foundation Dev Plugin Options

```js
foundationDevPlugin({
  name: 'foundation',          // Name for logging
  path: '../foundation',       // Path to foundation package
  serve: '/foundation',        // URL path to serve from
  watch: true,                 // Watch for source changes
  buildOnStart: true           // Build when dev server starts
})
```

### Programmatic API

```js
import {
  discoverComponents,
  buildSchema,
  generateEntryPoint,
  processAllPreviews
} from '@uniweb/build'

// Discover components in a foundation
const components = await discoverComponents('./src')
// => { Hero: { title: 'Hero Banner', ... }, Features: { ... } }

// Build complete schema
const schema = await buildSchema('./src')
// => { _self: { name: 'My Foundation' }, Hero: {...}, Features: {...} }

// Generate entry point
await generateEntryPoint('./src', './src/_entry.generated.js')

// Process preview images
const { schema: withImages, totalImages } = await processAllPreviews(
  './src',
  './dist',
  schema,
  true // production mode - converts to webp
)
```

## Foundation Structure

Foundations use a folder-based component structure:

```
src/
├── meta.js                    # Foundation-level metadata
├── index.css                  # Global styles (Tailwind)
├── components/
│   └── Hero/
│       ├── index.jsx          # Component implementation
│       ├── meta.js            # Component metadata
│       └── previews/          # Preset preview images
│           └── default.png
```

### Component Meta File

```js
// src/sections/Hero/meta.js
export default {
  title: 'Hero Banner',
  description: 'A prominent header section',
  category: 'Headers',

  elements: {
    title: { label: 'Headline', required: true },
    subtitle: { label: 'Subtitle' },
  },

  properties: {
    alignment: {
      type: 'select',
      label: 'Text Alignment',
      options: [
        { value: 'center', label: 'Center' },
        { value: 'left', label: 'Left' },
      ],
      default: 'center',
    },
  },

  presets: {
    default: { label: 'Default', properties: {} },
    dark: { label: 'Dark Theme', properties: { theme: 'dark' } },
  },
}
```

### Foundation Meta File

```js
// src/meta.js
export default {
  name: 'My Foundation',
  description: 'Components for marketing websites',

  // Runtime props available to all components
  props: {
    themeToggleEnabled: true,
  },

  // Foundation-wide style configuration
  styleFields: [
    {
      id: 'primary-color',
      type: 'color',
      label: 'Primary Color',
      default: '#3b82f6',
    },
  ],
}
```

## Build Output

After building, your foundation will contain:

```
dist/
├── foundation.js      # Bundled components (~6KB typical)
├── foundation.js.map  # Source map
└── meta/              # Editor metadata (not needed at runtime)
    ├── schema.json    # Full component metadata for editors
    └── previews/      # Preset preview images
        └── Hero/
            └── default.webp
```

### Schema.json Structure

The generated `schema.json` contains:

```json
{
  "_self": {
    "name": "foundation",
    "version": "0.1.0",
    "description": "My foundation description",
    "vars": { ... }
  },
  "Hero": { ... },
  "Features": { ... }
}
```

The `_self` object contains foundation-level metadata:

| Field | Source | Description |
|-------|--------|-------------|
| `name` | `package.json` | Foundation package name |
| `version` | `package.json` | Foundation version |
| `description` | `package.json` | Foundation description |
| `vars` | `foundation.js` | CSS custom properties sites can override |

Identity fields (`name`, `version`, `description`) come from the foundation's `package.json`. Configuration fields (`vars`, etc.) come from `src/foundation.js`.

## API Reference

### Schema Functions

| Function | Description |
|----------|-------------|
| `discoverComponents(srcDir)` | Discover all section types (folders with meta.js) |
| `loadComponentMeta(componentDir)` | Load meta file for a component |
| `loadPackageJson(srcDir)` | Load identity from package.json |
| `loadFoundationConfig(srcDir)` | Load foundation.js configuration |
| `buildSchema(srcDir)` | Build complete schema object |

### Entry Generation

| Function | Description |
|----------|-------------|
| `generateEntryPoint(srcDir, outputPath)` | Generate foundation entry file |

#### Generated Entry Exports

The generated `_entry.generated.js` file exports:

| Export | Description |
|--------|-------------|
| `components` | Object map of component name → React component |
| Named exports | Each component exported by name (e.g., `Hero`, `Features`) |
| `capabilities` | Custom Layout and props from `src/exports.js` (or `null`) |
| `meta` | Runtime metadata extracted from component `meta.js` files |

#### Runtime Metadata (`meta` export)

Some properties in `meta.js` are needed at runtime, not just editor-time. These are extracted into the `meta` export to keep them available without loading the full `schema.json`.

Currently extracted properties:
- `input` - Form input schemas (for components that accept user input)

Example `meta.js` with form schema:
```javascript
export default {
  title: 'Contact Form',
  // ... editor-only properties ...

  // This gets extracted to the runtime `meta` export
  input: {
    name: { type: 'text', label: 'Name', required: true },
    email: { type: 'email', label: 'Email', required: true },
    message: { type: 'textarea', label: 'Message' }
  }
}
```

Generated entry will include:
```javascript
export const meta = {
  "ContactForm": {
    "input": {
      "name": { "type": "text", "label": "Name", "required": true },
      // ...
    }
  }
}
```

To add more runtime properties, update `RUNTIME_META_KEYS` in `src/generate-entry.js`.

### Image Processing

| Function | Description |
|----------|-------------|
| `processComponentPreviews(componentDir, name, outputDir, isProduction)` | Process one component's previews |
| `processAllPreviews(srcDir, outputDir, schema, isProduction)` | Process all preview images |

### Vite Plugins

**Foundation plugins** (`@uniweb/build`):

| Plugin | Description |
|--------|-------------|
| `foundationPlugin(options)` | Combined dev + build plugin |
| `foundationBuildPlugin(options)` | Build-only plugin |
| `foundationDevPlugin(options)` | Dev-only plugin with HMR |

**Site plugins** (`@uniweb/build/site` and `@uniweb/build/dev`):

| Plugin | Description |
|--------|-------------|
| `siteContentPlugin(options)` | Collect and inject site content |
| `collectSiteContent(sitePath)` | Programmatic content collection |
| `foundationDevPlugin(options)` | Serve foundation during site dev |

## Related Packages

- [`@uniweb/core`](https://github.com/uniweb/core) - Core classes (Uniweb, Website, Block)
- [`@uniweb/kit`](https://github.com/uniweb/kit) - Component library for foundations
- [`@uniweb/runtime`](https://github.com/uniweb/runtime) - Browser runtime for sites
- [`uniweb`](https://github.com/uniweb/cli) - CLI for creating projects

## License

Apache 2.0
