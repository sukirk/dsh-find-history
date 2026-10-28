/**
 * dsh-find-history — backfill worker.
 *
 * Reads a batch of Session logs that the corpus has never seen and writes their
 * documents. It runs as a short-lived child process on purpose: inflating frames
 * leaves memory behind in the Node process that does it, and the whole point of
 * a batch is to hand that memory back to the operating system the moment the
 * batch is done. The parent stays small while the history is built.
 *
 * Usage: node backfill.mjs <documents directory> <cache root> <JSON batch>
 * where the batch is [{ sessionId, path, size, mtimeMs }].
 */
import { readLogFull } from './scan.mjs'
import { saveSessionDoc } from './store.mjs'

const [, , docsDir, , batchJson] = process.argv

let batch
try {
	batch = JSON.parse(batchJson ?? '[]')
} catch {
	process.exitCode = 1
	process.exit()
}

const paths = { docs: docsDir }
const report = { indexed: 0, frames: 0, skipped: 0 }

for (const record of batch) {
	if (typeof record?.path !== 'string' || typeof record?.sessionId !== 'string') {
		report.skipped += 1
		continue
	}
	const part = readLogFull(record.path)
	if (part === null) {
		report.skipped += 1
		continue
	}
	saveSessionDoc(paths, record.sessionId, {
		path: record.path,
		size: record.size,
		mtimeMs: record.mtimeMs,
		readBytes: part.readBytes,
		frames: part.frames,
		cwd: part.cwd,
		title: part.title,
		live: false,
		readAt: Date.now(),
		messages: part.messages,
		outputs: part.outputs,
	})
	report.indexed += 1
	report.frames += part.frames
}

process.stdout.write(JSON.stringify(report))
