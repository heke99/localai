from pathlib import Path

path = Path('services/agent-worker/src/processor.ts')
text = path.read_text()

replacements = [
    ('const CANCELLATION_POLL_MS = 150;\nconst STREAM_FLUSH_MS = 75;\nconst STREAM_FLUSH_CHARS = 512;',
     'const CANCELLATION_POLL_MS = 500;\nconst STREAM_FLUSH_MS = 150;\nconst STREAM_FLUSH_CHARS = 1024;'),
    ('async function generateWithCancellation(', 'export async function generateWithCancellation('),
    ('''  let pendingStream = "";\n  let lastStreamFlush = performance.now();\n\n  const flushStream = async () => {\n    if (!pendingStream) return;\n    const chunk = pendingStream;\n    pendingStream = "";\n    lastStreamFlush = performance.now();\n    await queue.stream(run.runId, chunk);\n  };\n\n  const onDelta = async (delta: string) => {\n    if (!streamOutput) return;\n    pendingStream += delta;\n    if (pendingStream.length >= STREAM_FLUSH_CHARS || performance.now() - lastStreamFlush >= STREAM_FLUSH_MS) await flushStream();\n  };''',
     '''  let pendingStream = "";\n  let lastStreamFlush = performance.now();\n  let streamWrite = Promise.resolve();\n  let streamWriteError: unknown = null;\n\n  // Persist stream chunks in-order, but never make Qwen wait on the Supabase\n  // round trip for every UI flush. Backpressure is drained before the model\n  // result is returned, so completion can never outrun durable stream state.\n  const enqueueStreamFlush = () => {\n    if (!pendingStream || streamWriteError) return;\n    const chunk = pendingStream;\n    pendingStream = "";\n    lastStreamFlush = performance.now();\n    streamWrite = streamWrite.then(async () => {\n      if (streamWriteError) return;\n      try {\n        await queue.stream(run.runId, chunk);\n      } catch (error) {\n        streamWriteError = error;\n      }\n    });\n  };\n\n  const drainStream = async () => {\n    enqueueStreamFlush();\n    await streamWrite;\n    if (streamWriteError) throw streamWriteError;\n  };\n\n  const onDelta = async (delta: string) => {\n    if (!streamOutput) return;\n    pendingStream += delta;\n    if (pendingStream.length >= STREAM_FLUSH_CHARS || performance.now() - lastStreamFlush >= STREAM_FLUSH_MS) enqueueStreamFlush();\n  };'''),
    ('if (streamOutput) await flushStream();', 'if (streamOutput) await drainStream();')
]

for old, new in replacements:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'expected exactly one match, got {count}: {old[:80]!r}')
    text = text.replace(old, new, 1)

path.write_text(text)
