// ⭐ THE FOLDER IS THE DECLARATION [Diego, 2026-09-24]: every schema file in a
// foundation's `schemas/` folder is one it defines, so `register` submits it — not
// only the schemas a section binding reaches. Asked for by a team whose app-only
// types (a lesson, a quiz, a learner's progress) are bound to no section and so were
// never registered. A file named with a leading `_` is a draft, left out.
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSchema } from '../src/schema.js'
import { buildRegistryPackage } from '../src/uwx/registry-package.js'

let dir

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uw-own-schemas-'))
  const write = (rel, text) => {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
  write('package.json', JSON.stringify({ name: 'src', version: '1.0.0', type: 'module' }))
  write('main.js', "export default { name: '@acme/courses' }\n")
  write('sections/Course/meta.js', "export default { title: 'Course', data: { course: '@/course' } }\n")
  write('schemas/course.yml', 'name: course\nfields:\n  title: { type: string, required: true }\n')
  write('schemas/lesson.yml', 'name: lesson\nfields:\n  title: { type: string }\n')
  write('schemas/progress.yml', 'name: progress\nfields:\n  done: { type: boolean }\n')
  write('schemas/_draft.yml', 'name: _draft\nfields:\n  x: { type: string }\n')
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("a foundation's own schemas", () => {
  it('schema.json carries every schema in schemas/ — bound first, then the rest — and no draft', async () => {
    const schema = await buildSchema(dir)
    expect(Object.keys(schema.dataSchemas)).toEqual(['@/course', '@/lesson', '@/progress'])
  })

  it('register submits the ones no section binds', async () => {
    const schema = await buildSchema(dir)
    const pkg = buildRegistryPackage({ schema, scope: '@acme' })
    const names = pkg.entities.filter((e) => e.model === '@uniweb/data-schema').map((e) => e.name)
    expect(names).toEqual(['@acme/course', '@acme/lesson', '@acme/progress'])
  })
})
