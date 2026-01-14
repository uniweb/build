# @uniweb/build

Foundation build tooling for the Uniweb Component Web Platform.

## Overview

This package provides build utilities for creating Uniweb Foundations—React component libraries that define the vocabulary and rendering logic for content-driven websites.

## Installation

```bash
npm install @uniweb/build --save-dev
```

## Features

- **Component Discovery** - Automatically discovers components from `src/components/*/meta.js`
- **Entry Generation** - Generates the foundation entry point with all exports
- **Schema Building** - Creates `schema.json` with full component metadata for editors
- **Image Processing** - Converts preview images to WebP format with dimension extraction
- **Vite Plugin** - Integrates seamlessly with Vite builds

## Usage

### Vite Plugin

Add the foundation plugin to your `vite.config.js`:

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
// src/components/Hero/meta.js
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
├── schema.json        # Full metadata for editors
└── assets/
    └── Hero/
        └── default.webp  # Processed preview images
```

## API Reference

### Schema Functions

| Function | Description |
|----------|-------------|
| `discoverComponents(srcDir)` | Discover all exposed components |
| `loadComponentMeta(componentDir)` | Load meta file for a component |
| `loadFoundationMeta(srcDir)` | Load foundation-level meta |
| `buildSchema(srcDir)` | Build complete schema object |
| `buildRuntimeConfig(srcDir)` | Build minimal runtime config |

### Entry Generation

| Function | Description |
|----------|-------------|
| `generateEntryPoint(srcDir, outputPath)` | Generate foundation entry file |

### Image Processing

| Function | Description |
|----------|-------------|
| `processComponentPreviews(componentDir, name, outputDir, isProduction)` | Process one component's previews |
| `processAllPreviews(srcDir, outputDir, schema, isProduction)` | Process all preview images |

### Vite Plugins

| Plugin | Description |
|--------|-------------|
| `foundationPlugin(options)` | Combined dev + build plugin |
| `foundationBuildPlugin(options)` | Build-only plugin |
| `foundationDevPlugin(options)` | Dev-only plugin with HMR |

## Related Packages

- [`uniweb`](https://github.com/uniweb/cli) - CLI for creating Uniweb projects
- [`@uniweb/runtime`](https://github.com/uniweb/runtime) - Runtime loader for sites

## License

Apache 2.0
