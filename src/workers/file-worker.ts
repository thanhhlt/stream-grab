/**
 * File worker (0.6.0): writes the progressive files the engine fetches to the
 * origin private file system through synchronous access handles, which only
 * a dedicated worker has. Started by the offscreen document with the first
 * file it opens; every byte written here survives the document closing and
 * the browser being killed, so the next run continues the file with a Range
 * request (see partial-files.ts).
 */
import { PartialFileHost, PARTIAL_DIRECTORY, SyncPartialFiles } from '@/core/download/partial-files';
import { OpfsOutputFiles } from '@/core/media/output-files';

const host = new PartialFileHost(new SyncPartialFiles(new OpfsOutputFiles(undefined, PARTIAL_DIRECTORY)));

self.onmessage = (event: MessageEvent) => {
  void host.handle(event.data).then((response) => {
    self.postMessage(response);
  });
};
