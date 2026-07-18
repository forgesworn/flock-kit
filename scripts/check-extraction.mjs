#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'compatibility/v1/extraction-manifest.json'), 'utf8'))

function filesBelow(directory, base = directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => entry.isDirectory()
      ? filesBelow(join(directory, entry.name), base)
      : [relative(base, join(directory, entry.name))])
    .sort()
}

function digest(directory, files) {
  const hash = createHash('sha256')
  for (const path of files) {
    hash.update(path)
    hash.update(Buffer.from([0]))
    hash.update(readFileSync(join(directory, path)))
    hash.update(Buffer.from([0]))
  }
  return hash.digest('hex')
}

const sourceFiles = filesBelow(join(root, 'src'))
const sourceSha256 = digest(join(root, 'src'), sourceFiles)
const vectorSha256 = digest(join(root, 'compatibility/v1'), manifest.vectorFiles)
const failures = []

if (sourceFiles.length !== manifest.sourceFileCount) {
  failures.push(`source file count ${sourceFiles.length} != ${manifest.sourceFileCount}`)
}
if (sourceSha256 !== manifest.sourceSha256) failures.push(`source digest ${sourceSha256} != ${manifest.sourceSha256}`)
if (vectorSha256 !== manifest.vectorSha256) failures.push(`vector digest ${vectorSha256} != ${manifest.vectorSha256}`)

if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exit(1)
}

console.log(`verified history extraction from Flock ${manifest.sourceCommit}`)
console.log(`source tree ${manifest.sourceGitTreeSha1}; ${sourceFiles.length} files; vectors ${vectorSha256}`)
