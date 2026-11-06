/**
 * Loads the real FFmpeg.wasm core (the file the extension ships) into Node,
 * for tests and for generating synthetic media fixtures. Plain relative
 * imports only: scripts/fixture-server.ts runs this file directly in Node.
 *
 * The core is built for Web Workers only. Node gets just enough of that
 * environment: `self.location` (where the core looks for itself; the
 * WebAssembly bytes are handed over directly) and `FileReaderSync`, which
 * WORKERFS uses to read mounted Blobs synchronously. Node has no synchronous
 * Blob reader, so tests mount SyncBlob, which has the two members WORKERFS
 * uses (`size`, `slice`).
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CreateFfmpegCore, FfmpegCore } from '../../../src/core/media/ffmpeg-core.ts';

const coreDir = resolve(dirname(createRequire(import.meta.url).resolve('@ffmpeg/core/wasm')), '..', 'esm');
let wasm: Uint8Array | undefined;
let factory: Promise<CreateFfmpegCore> | undefined;

/** Bytes WORKERFS can read synchronously. */
export class SyncBlob {
  readonly bytes: Uint8Array;
  readonly size: number;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.size = bytes.length;
  }

  slice(start = 0, end = this.size): SyncBlob {
    return new SyncBlob(this.bytes.subarray(start, end));
  }
}

function installWorkerGlobals(): void {
  const scope = globalThis as Record<string, unknown>;
  scope['self'] ??= { location: { href: pathToFileURL(resolve(coreDir, 'ffmpeg-core.js')).href } };
  scope['FileReaderSync'] ??= class {
    readAsArrayBuffer(blob: SyncBlob): ArrayBuffer {
      return blob.bytes.slice().buffer;
    }
  };
}

export function loadCoreFactory(): Promise<CreateFfmpegCore> {
  factory ??= (async () => {
    installWorkerGlobals();
    const module = (await import(pathToFileURL(resolve(coreDir, 'ffmpeg-core.js')).href)) as { default: CreateFfmpegCore };
    return module.default;
  })();
  return factory;
}

/** The WebAssembly module's bytes, read once. */
export function coreWasm(): Uint8Array {
  return (wasm ??= readFileSync(resolve(coreDir, 'ffmpeg-core.wasm')));
}

/** A fresh FFmpeg instance (each one compiles the module). */
export async function createNodeCore(): Promise<FfmpegCore> {
  const create = await loadCoreFactory();
  return create({ wasmBinary: coreWasm() });
}
