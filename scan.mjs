/**
 * dsh-find-history — Session log reading.
 *
 * A Session log is a concatenation of zstandard frames, and every frame holds
 * whole JSON event lines. Only a handful of event types carry what the search
 * corpus keeps, so this reader inflates one frame at a time, hands the text to a
 * line scanner that parses nothing but the wanted lines, and covers only the
 * bytes the caller asks for. That keeps the cost of a pass proportional to the
 * messages found instead of the megabytes stored.
 *
 * Two kinds of text are kept: what the user typed, and the answer the assistant
 * gave at the end of each turn. Intermediate assistant steps (tool calls, status
 * lines) are dropped on purpose, so searching outputs finds conclusions rather
 * than work logs.
 */
import { closeSync, openSync, readFileSync, readSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

/** Every zstandard frame starts with this magic number. */
export const FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Only messages the user typed carry this source kind. Older logs written
 * before the marker existed are kept, because their author is unknown.
 */
const USER_SOURCE_KIND = 'user'

/** Event types the corpus keeps, matched against the raw line before parsing it. */
const MARK_USER = Buffer.from('"type":"user/message"')
const MARK_ASSISTANT = Buffer.from('"type":"assistant/message"')
const MARK_TURN = Buffer.from('"type":"turn/start"')
const MARK_TITLE = Buffer.from('"type":"session/title"')
const MARK_HEADER = Buffer.from('"type":"session"')
/** Every event line starts with the type key, so one compare skips most lines. */
const MARK_PREFIX = Buffer.from('{"type":"')
const LINE_BREAK = 0x0a
/** Payload types found while scanning one raw line. */
const LINE_USER = 1
const LINE_ASSISTANT = 2
const LINE_TURN = 3
const LINE_TITLE = 4
const LINE_HEADER = 5
/** One stored message is capped so a pasted file cannot grow the corpus without bound. */
export const MAX_MESSAGE_CHARS = 20_000

/**
 * Cap one message while keeping both ends: a pasted log is usually interesting
 * at its head (the question) and its tail (the error), so cutting only the tail
 * makes keywords after 20k characters permanently unfindable.
 * @param {string} text - message text.
 * @returns {string} text unchanged, or head + marker + tail within the cap.
 */
export function capMessageText(text) {
  const value = String(text ?? '')
  if (value.length <= MAX_MESSAGE_CHARS) return value
  const marker = '\n…\n'
  const half = Math.floor((MAX_MESSAGE_CHARS - marker.length) / 2)
  return `${value.slice(0, half)}${marker}${value.slice(value.length - half)}`
}

/**
 * Read the first-party text of one user message.
 * @param {object} data - event payload of a `user/message` event.
 * @returns {string} joined text blocks, with blank lines collapsed.
 */
export function readMessageText(data) {
  const content = data?.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue
    if (block.text === '') continue
    parts.push(block.text)
  }
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Read the visible text of one assistant message. Reasoning blocks and tool
 * calls are left out: only what the user could read in the transcript counts.
 * @param {object} data - event payload of an `assistant/message` event.
 * @returns {string} joined text blocks, with blank lines collapsed.
 */
export function readAssistantText(data) {
  return readMessageText(data?.message)
}

/**
 * Tell which corpus-relevant event a raw log line carries, without parsing it.
 * @param {Buffer} line - one line of the decompressed log, without its newline.
 * @returns {number} one of the `LINE_*` kinds, or 0 when the line is skipped.
 */
function classifyLine(line) {
  const prefix = MARK_PREFIX.length
  if (line.length > prefix && line.compare(MARK_PREFIX, 0, prefix, 0, prefix) === 0) {
    if (line.compare(MARK_USER, 0, MARK_USER.length, 1, 1 + MARK_USER.length) === 0) return LINE_USER
    if (line.compare(MARK_ASSISTANT, 0, MARK_ASSISTANT.length, 1, 1 + MARK_ASSISTANT.length) === 0) {
      return LINE_ASSISTANT
    }
    if (line.compare(MARK_TURN, 0, MARK_TURN.length, 1, 1 + MARK_TURN.length) === 0) return LINE_TURN
    if (line.compare(MARK_TITLE, 0, MARK_TITLE.length, 1, 1 + MARK_TITLE.length) === 0) return LINE_TITLE
    if (line.compare(MARK_HEADER, 0, MARK_HEADER.length, 1, 1 + MARK_HEADER.length) === 0) return LINE_HEADER
    return 0
  }
  // A rare line whose keys are ordered differently; scan it in full.
  if (line.includes(MARK_USER)) return LINE_USER
  if (line.includes(MARK_ASSISTANT)) return LINE_ASSISTANT
  if (line.includes(MARK_TURN)) return LINE_TURN
  if (line.includes(MARK_TITLE)) return LINE_TITLE
  if (line.includes(MARK_HEADER)) return LINE_HEADER
  return 0
}

/**
 * Move the answer held for the finished turn into the output list.
 * @param {object} state - Session state under construction.
 */
function commitOutput(state) {
  const pending = state.pending
  if (pending === null) return
  state.pending = null
  state.outputs.push({
    turn: Number.isFinite(pending.turn) ? pending.turn : null,
    seq: pending.seq,
    time: pending.time,
    text: pending.text,
    lower: pending.lower,
    truncated: pending.truncated === true,
  })
}

/**
 * Commit the answer of the last turn, once no further event can replace it.
 * @param {object} state - Session state being finished.
 */
export function finishState(state) {
  commitOutput(state)
}

/**
 * Fold one parsed event into the state being built.
 * @param {object} state - Session state under construction.
 * @param {object} event - parsed Session event.
 */
function applyEvent(state, event) {
  if (event === null || typeof event !== 'object') return
  if (event.type === 'session') {
    if (typeof event.id === 'string') state.sessionId = event.id
    if (typeof event.cwd === 'string') state.cwd = event.cwd
    return
  }
  if (event.type === 'session/title') {
    const title = event.data?.title
    if (typeof title === 'string' && title !== '') state.title = title
    return
  }
  if (event.type === 'turn/start') {
    const turn = event.data?.turn
    if (Number.isFinite(turn)) state.turn = turn
    commitOutput(state)
    return
  }
  if (event.type === 'assistant/message') {
    const turn = Number.isFinite(event.data?.turn) ? event.data.turn : state.turn
    const raw = readAssistantText(event.data)
    const text = capMessageText(raw)
    if (text === '') return
    const truncated = text !== raw
    // Every step of a turn writes its own assistant message; only the last one
    // carries the answer, so an earlier step's text is replaced, not appended.
    if (state.pending !== null && state.pending.turn === turn) {
      state.pending.seq = Number.isFinite(event.seq) ? event.seq : state.pending.seq
      state.pending.time = Number.isFinite(event.time) ? event.time : state.pending.time
      state.pending.text = text
      state.pending.lower = text.toLowerCase()
      state.pending.truncated = truncated
      return
    }
    commitOutput(state)
    state.pending = {
      turn,
      seq: Number.isFinite(event.seq) ? event.seq : 0,
      time: Number.isFinite(event.time) ? event.time : 0,
      text,
      lower: text.toLowerCase(),
      truncated,
    }
    return
  }
  if (event.type !== 'user/message') return
  const kind = event.data?.source?.kind
  // A known foreign source is harness context, not the user's own words.
  if (kind !== undefined && kind !== null && kind !== USER_SOURCE_KIND) return
  const text = readMessageText(event.data)
  if (text === '') return
  commitOutput(state)
  const capped = capMessageText(text)
  state.messages.push({
    seq: Number.isFinite(event.seq) ? event.seq : 0,
    time: Number.isFinite(event.time) ? event.time : 0,
    text: capped,
    lower: capped.toLowerCase(),
    truncated: capped !== text,
  })
}

/**
 * Build a line scanner that parses only the lines the corpus keeps.
 * @param {object} state - state the parsed events are folded into.
 * @returns {{ push: (chunk: Buffer) => void, end: () => void }} scanner.
 */
function createScanner(state) {
  let carry = null
  const handle = (line) => {
    const kind = classifyLine(line)
    if (kind === 0) return
    let event
    try {
      event = JSON.parse(line.toString('utf8'))
    } catch {
      return
    }
    applyEvent(state, event)
  }
  return {
    push(chunk) {
      const data = carry !== null && carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk
      let start = 0
      let index = data.indexOf(LINE_BREAK, start)
      while (index !== -1) {
        if (index > start) handle(data.subarray(start, index))
        start = index + 1
        index = data.indexOf(LINE_BREAK, start)
      }
      carry = start < data.length ? Buffer.from(data.subarray(start)) : null
    },
    end() {
      if (carry !== null && carry.length > 0) handle(carry)
      carry = null
    },
  }
}

/** How many candidate frame starts a damaged range may be probed at before giving up. */
const MAX_RECOVERY_ATTEMPTS = 32

/**
 * Walk the zstandard frame that starts at `start` and return the offset just
 * past it, without decompressing anything.
 *
 * A frame boundary cannot be found by searching for the magic number: the same
 * four bytes can occur inside a compressed payload by chance, and treating that
 * as a boundary splits a frame in half and loses its lines. Parsing the frame
 * header and block headers instead always lands on the real boundary.
 * @param {Buffer} buffer - raw log bytes.
 * @param {number} start - offset that must hold a frame magic.
 * @returns {number | null} end offset, or null when the bytes do not hold a whole frame.
 */
function frameEnd(buffer, start) {
  if (start + 4 > buffer.length) return null
  if (!buffer.subarray(start, start + 4).equals(FRAME_MAGIC)) return null
  let pos = start + 4
  if (pos >= buffer.length) return null
  const descriptor = buffer[pos]
  pos += 1
  const contentSizeFlag = descriptor >> 6
  const singleSegment = ((descriptor >> 5) & 1) === 1
  const checksum = ((descriptor >> 2) & 1) === 1
  const dictionaryFlag = descriptor & 0b11
  // Window_Descriptor is present only when the frame does not carry its size.
  if (!singleSegment) {
    if (pos >= buffer.length) return null
    pos += 1
  }
  const dictionaryBytes = dictionaryFlag === 0 ? 0 : dictionaryFlag === 1 ? 1 : dictionaryFlag === 2 ? 2 : 4
  if (pos + dictionaryBytes > buffer.length) return null
  pos += dictionaryBytes
  const contentSizeBytes =
    contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : contentSizeFlag === 1 ? 2 : contentSizeFlag === 2 ? 4 : 8
  if (pos + contentSizeBytes > buffer.length) return null
  pos += contentSizeBytes
  for (;;) {
    if (pos + 3 > buffer.length) return null
    const header = buffer[pos] | (buffer[pos + 1] << 8) | (buffer[pos + 2] << 16)
    pos += 3
    const lastBlock = (header & 1) === 1
    const blockType = (header >> 1) & 0b11
    const blockSize = header >>> 3
    if (blockType === 0b11) return null // reserved block type: not a real frame
    // RLE blocks store one byte that expands to blockSize bytes.
    const payloadBytes = blockType === 0b01 ? 1 : blockSize
    if (pos + payloadBytes > buffer.length) return null
    pos += payloadBytes
    if (lastBlock) break
  }
  if (checksum) {
    if (pos + 4 > buffer.length) return null
    pos += 4
  }
  return pos
}

/**
 * Find the next offset at or after `from` where a frame starts and inflates.
 * Used only after a frame failed: the payload may contain a stray magic, and a
 * partially written frame must not swallow the frames that follow it.
 * @param {Buffer} buffer - raw log bytes.
 * @param {number} from - offset to start searching at.
 * @returns {number} offset of a frame that decompresses to the end of the buffer, or -1.
 */
function recoverableFrame(buffer, from) {
  let index = buffer.indexOf(FRAME_MAGIC, from)
  let attempts = 0
  while (index !== -1 && attempts < MAX_RECOVERY_ATTEMPTS) {
    attempts += 1
    try {
      zstdDecompressSync(buffer.subarray(index))
      return index
    } catch {
      /* not a real frame start either */
    }
    index = buffer.indexOf(FRAME_MAGIC, index + 1)
  }
  return -1
}

/**
 * An empty Session state.
 * @returns {object} state the scanner folds into.
 */
export function createState() {
  return { sessionId: null, cwd: null, title: null, messages: [], outputs: [], turn: null, pending: null }
}

/**
 * Inflate the frames of one log range into a Session state.
 * A trailing frame that does not inflate is a log being appended to; it stays
 * uncovered so the next pass reads it whole, because a partially written frame
 * must never be skipped. A damaged frame in the middle is skipped (its lines are
 * lost, which `damaged` reports) so the frames after it still arrive.
 * @param {Buffer} buffer - raw log bytes, starting at a frame boundary.
 * @param {object} state - Session state to fold into.
 * @returns {{ frames: number, damaged: number, consumed: number, complete: boolean }} coverage.
 */
export function scanBuffer(buffer, state) {
  const scanner = createScanner(state)
  let frames = 0
  let damaged = 0
  let consumed = 0
  let complete = true
  let cursor = 0
  while (cursor < buffer.length) {
    const start = buffer.indexOf(FRAME_MAGIC, cursor)
    if (start === -1) {
      // Bytes after the last complete frame that hold no frame magic at all are
      // not a half-written frame; cover them so the next pass does not re-read
      // the whole log looking for a boundary that never existed.
      if (frames > 0) consumed = buffer.length
      break
    }
    const end = frameEnd(buffer, start)
    if (end !== null) {
      let plain = null
      try {
        plain = zstdDecompressSync(buffer.subarray(start, end))
      } catch {
        plain = null
      }
      if (plain !== null) {
        scanner.push(plain)
        frames += 1
        consumed = end
        cursor = end
        continue
      }
    }
    // This frame did not inflate: either it is still being written, or its
    // payload contains a stray magic. Look for the next frame that really
    // inflates and continue there instead of losing everything after it.
    const recovered = recoverableFrame(buffer, start + 1)
    if (recovered === -1) {
      complete = false
      consumed = start
      break
    }
    damaged += 1
    consumed = recovered
    cursor = recovered
  }
  scanner.end()
  return { frames, damaged, consumed, complete }
}

/**
 * Read a whole Session log.
 * @param {string} path - log file path.
 * @returns {{ cwd: string | null, title: string | null, messages: object[], frames: number, readBytes: number, size: number, complete: boolean } | null} what the log holds, or null when unreadable.
 */
export function readLogFull(path) {
  let buffer
  try {
    buffer = readFileSync(path)
  } catch {
    return null
  }
  const state = createState()
  const coverage = scanBuffer(buffer, state)
  finishState(state)
  return {
    cwd: state.cwd,
    title: state.title,
    messages: state.messages,
    outputs: state.outputs,
    frames: coverage.frames,
    damaged: coverage.damaged,
    readBytes: coverage.consumed,
    size: buffer.length,
    complete: coverage.complete,
  }
}

/**
 * Read the bytes a Session log gained since the last read.
 * @param {string} path - log file path.
 * @param {number} from - byte offset already covered; must be a frame boundary.
 * @param {number} size - current file size.
 * @returns {{ cwd: string | null, title: string | null, messages: object[], frames: number, readBytes: number, size: number, complete: boolean } | null} the new part, or null when the offset is not a frame boundary anymore.
 */
export function readLogTail(path, from, size) {
  const length = size - from
  if (length < FRAME_MAGIC.length) return null
  const buffer = Buffer.allocUnsafe(length)
  let offset = 0
  try {
    const handle = openSync(path, 'r')
    try {
      while (offset < length) {
        const read = readSync(handle, buffer, offset, length - offset, from + offset)
        if (read <= 0) break
        offset += read
      }
    } finally {
      closeSync(handle)
    }
  } catch {
    return null
  }
  const bytes = offset === length ? buffer : buffer.subarray(0, offset)
  // A rewritten log no longer starts this range with a frame, so the offset is
  // not trustworthy anymore; the caller re-reads the whole file instead.
  if (bytes.length < FRAME_MAGIC.length) return null
  if (!bytes.subarray(0, FRAME_MAGIC.length).equals(FRAME_MAGIC)) return null
  const state = createState()
  const coverage = scanBuffer(bytes, state)
  finishState(state)
  return {
    cwd: state.cwd,
    title: state.title,
    messages: state.messages,
    outputs: state.outputs,
    frames: coverage.frames,
    damaged: coverage.damaged,
    readBytes: from + coverage.consumed,
    size,
    complete: coverage.complete,
  }
}

/**
 * Merge two seq-ordered message lists, newer entries winning.
 * @param {object[]} older - messages already held.
 * @param {object[]} newer - messages just read.
 * @returns {object[]} merged list ordered by seq.
 */
export function mergeMessages(older, newer) {
  if (newer.length === 0) return older
  if (older.length === 0) return newer
  const merged = [...older]
  const seen = new Set(merged.map((message) => message.seq))
  for (const message of newer) {
    if (seen.has(message.seq)) continue
    seen.add(message.seq)
    merged.push(message)
  }
  merged.sort((left, right) => left.seq - right.seq)
  return merged
}

/**
 * Merge two answer lists, newer entries winning per turn.
 * A tail read can see the same turn twice: an intermediate step first, then the
 * final answer, so the entry with the higher seq replaces the earlier one.
 * @param {object[]} older - answers already held.
 * @param {object[]} newer - answers just read.
 * @returns {object[]} merged list ordered by seq.
 */
export function mergeOutputs(older, newer) {
  if (newer.length === 0) return older
  if (older.length === 0) return newer
  const byKey = new Map()
  for (const row of older) {
    byKey.set(outputKey(row), row)
  }
  for (const row of newer) {
    const key = outputKey(row)
    const held = byKey.get(key)
    if (held === undefined || row.seq >= held.seq) byKey.set(key, row)
  }
  return [...byKey.values()].sort((left, right) => left.seq - right.seq)
}

/**
 * Identify the turn one answer belongs to, falling back to its seq.
 * @param {object} row - answer entry.
 * @returns {string} merge key.
 */
function outputKey(row) {
  return row.turn === null || row.turn === undefined ? `s${row.seq}` : `t${row.turn}`
}
