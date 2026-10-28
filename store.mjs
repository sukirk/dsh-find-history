/**
 * dsh-find-history — corpus storage.
 *
 * The corpus is one small document per Session, kept under the Harness cache
 * directory: the messages the user typed, the answer that closed each turn, plus
 * the byte offset, size and modification time the log had when it was read. A restart compares the
 * documents against the logs, so only Sessions that appeared or grew are read.
 * Documents are written atomically and independently, so a damaged or deleted
 * document only costs that one Session a re-read.
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** Directory under the Harness cache that owns this plugin's documents. */
const CACHE_DIR = 'find-history'
/** Cache directory the plugin used before it was renamed; moved aside on first start. */
const PREVIOUS_CACHE_DIR = 'session-history-search'
/** Session documents live in a subdirectory, one file each. */
const DOC_DIR = 'sessions'
/** Document format; a different version is read as an empty corpus. */
export const DOC_VERSION = 4
/** Session logs are named this way inside `<sessions>/<workspace>/<id>/`. */
export const SESSIONS_DIR = 'sessions'
export const LOG_FILE = 'session.v4.jsonl.zstd'
/** The single-file corpus of the previous version, imported once on upgrade. */
const LEGACY_NAME = 'session-history-search-messages.json'
const LEGACY_VERSION = 2

/**
 * Resolve the directories this plugin reads and writes.
 * @param ctx - Host context.
 * @returns {{ root: string, docs: string, logs: string } | null} directories, or null when the profile has no cache directory.
 */
export function indexPaths(ctx) {
  const dshHomePath = typeof ctx.get === 'function' ? ctx.get('dshHomePath') : null
  if (typeof dshHomePath !== 'function') return null
  const root = dshHomePath('cache', CACHE_DIR)
  migratePreviousCache(dshHomePath('cache'), root)
  return { root, docs: join(root, DOC_DIR), logs: dshHomePath(SESSIONS_DIR) }
}

/**
 * Rename the cache directory of the previous plugin name, so an existing index
 * is reused instead of rebuilt.
 * @param {(name: string) => string} cachePath - resolves a cache entry.
 * @param {string} root - current cache directory.
 */
function migratePreviousCache(cachePath, root) {
  try {
    if (existsSync(root)) return
    const previous = cachePath(PREVIOUS_CACHE_DIR)
    if (!existsSync(previous)) return
    renameSync(previous, root)
  } catch {
    // A failed rename only costs one rebuild.
  }
}

/**
 * Read one Session document.
 * @param {{ docs: string }} paths - directories.
 * @param {string} sessionId - Session id, also the file name.
 * @returns {object | null} entry, or null when absent or unreadable.
 */
export function readSessionDoc(paths, sessionId) {
  let doc
  try {
    doc = JSON.parse(readFileSync(join(paths.docs, `${sessionId}.json`), 'utf8'))
  } catch {
    return null
  }
  if (doc?.v !== DOC_VERSION || typeof doc.path !== 'string') return null
  if (!Array.isArray(doc.messages)) return null
  if (!Array.isArray(doc.outputs)) return null
  const messages = []
  for (const row of doc.messages) {
    if (!Array.isArray(row) || typeof row[2] !== 'string') continue
    messages.push({
      seq: Number(row[0]) || 0,
      time: Number(row[1]) || 0,
      text: row[2],
      lower: row[2].toLowerCase(),
    })
  }
  const outputs = []
  for (const row of doc.outputs) {
    if (!Array.isArray(row) || typeof row[2] !== 'string') continue
    outputs.push({
      seq: Number(row[0]) || 0,
      time: Number(row[1]) || 0,
      text: row[2],
      turn: Number.isFinite(Number(row[3])) ? Number(row[3]) : null,
      lower: row[2].toLowerCase(),
    })
  }
  return {
    path: doc.path,
    size: Number(doc.size) || 0,
    mtimeMs: Number(doc.mtime) || 0,
    readBytes: Number(doc.readBytes) || 0,
    frames: Number(doc.frames) || 0,
    cwd: typeof doc.cwd === 'string' ? doc.cwd : null,
    title: typeof doc.title === 'string' ? doc.title : null,
    live: doc.live === true,
    readAt: Number(doc.readAt) || 0,
    messages,
    outputs,
  }
}

/**
 * Write one Session document, replacing the previous copy atomically.
 * @param {{ docs: string }} paths - directories.
 * @param {string} sessionId - Session id, also the file name.
 * @param {object} entry - entry to store.
 */
export function saveSessionDoc(paths, sessionId, entry) {
  const body = JSON.stringify({
    v: DOC_VERSION,
    path: entry.path,
    size: entry.size,
    mtime: entry.mtimeMs,
    readBytes: entry.readBytes,
    frames: entry.frames,
    cwd: entry.cwd,
    title: entry.title,
    live: entry.live === true,
    readAt: entry.readAt,
    messages: entry.messages.map((message) => [message.seq, message.time, message.text]),
    outputs: entry.outputs.map((output) => [output.seq, output.time, output.text, output.turn]),
  })
  const target = join(paths.docs, `${sessionId}.json`)
  const temporary = join(paths.docs, `${sessionId}.tmp`)
  try {
    mkdirSync(paths.docs, { recursive: true })
    const handle = openSync(temporary, 'w')
    try {
      writeSync(handle, body, null, 'utf8')
    } finally {
      closeSync(handle)
    }
    renameSync(temporary, target)
  } catch {
    try {
      rmSync(temporary, { force: true })
    } catch {
      // The document is an optimization; a failed write only costs a re-read.
    }
  }
}

/**
 * Drop one Session document.
 * @param {{ docs: string }} paths - directories.
 * @param {string} sessionId - Session id.
 */
export function removeSessionDoc(paths, sessionId) {
  try {
    rmSync(join(paths.docs, `${sessionId}.json`), { force: true })
  } catch {
    // A stale document is pruned again by the next pass.
  }
}

/**
 * Load every Session document into the corpus.
 * @param {{ docs: string, root: string }} paths - directories.
 * @param {Map<string, object>} corpus - corpus to fill.
 */
export function loadCorpus(paths, corpus) {
  let names
  try {
    names = readdirSync(paths.docs)
  } catch {
    importLegacyCorpus(paths, corpus)
    return
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const entry = readSessionDoc(paths, name.slice(0, -'.json'.length))
    if (entry !== null) corpus.set(name.slice(0, -'.json'.length), entry)
  }
  if (corpus.size === 0) importLegacyCorpus(paths, corpus)
}

/**
 * Import the single-file corpus of the previous version, then remove it, so the
 * upgrade does not pay for a full re-read of every Session log.
 * @param {{ root: string, docs: string }} paths - directories.
 * @param {Map<string, object>} corpus - corpus to fill.
 */
function importLegacyCorpus(paths, corpus) {
  const legacyPath = join(paths.root, LEGACY_NAME)
  let parsed
  try {
    parsed = JSON.parse(readFileSync(legacyPath, 'utf8'))
  } catch {
    return
  }
  if (parsed?.version !== LEGACY_VERSION) return
  if (parsed.sessions === null || typeof parsed.sessions !== 'object') return
  for (const [sessionId, old] of Object.entries(parsed.sessions)) {
    if (old === null || typeof old !== 'object' || !Array.isArray(old.messages)) continue
    if (typeof old.path !== 'string') continue
    const messages = []
    for (const message of old.messages) {
      if (typeof message?.text !== 'string') continue
      messages.push({
        seq: Number(message.seq) || 0,
        time: Number(message.time) || 0,
        text: message.text,
        lower: message.text.toLowerCase(),
      })
    }
    // The old corpus recorded the bytes it had read but not the size and time of
    // the log they came from; statting the log now keeps the upgrade warm, since
    // only a Session that grew after that read needs to be read again.
    let size = 0
    let mtimeMs = 0
    try {
      const stats = statSync(old.path)
      size = stats.size
      mtimeMs = stats.mtimeMs
    } catch {
      continue
    }
    const entry = {
      path: old.path,
      size,
      mtimeMs,
      readBytes: Number(old.readBytes) || 0,
      frames: 0,
      cwd: typeof old.cwd === 'string' ? old.cwd : null,
      title: typeof old.title === 'string' ? old.title : null,
      live: old.live === true,
      readAt: Number(old.readAt) || 0,
      messages,
    }
    corpus.set(sessionId, entry)
    saveSessionDoc(paths, sessionId, entry)
  }
  try {
    rmSync(legacyPath, { force: true })
  } catch {
    // Leaving the old file behind only makes the next start import it again.
  }
}

/**
 * List the Session logs on disk, with the size and time the walk compares
 * against.
 * @param {string} root - sessions directory.
 * @returns {{ sessionId: string, path: string, size: number, mtimeMs: number }[]} one record per log.
 */
export function listLogRecords(root) {
  const records = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (entry.name !== LOG_FILE) continue
      let stats
      try {
        stats = statSync(path)
      } catch {
        continue
      }
      records.push({ sessionId: basename(dirname(path)), path, size: stats.size, mtimeMs: stats.mtimeMs })
    }
  }
  walk(root)
  return records
}
