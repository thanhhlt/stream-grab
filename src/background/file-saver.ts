import type { FileSaver } from '@/core/download/download-coordinator';

/**
 * Saving merged files with chrome.downloads, from the service worker. The URL
 * is a blob: URL of the offscreen document (service workers cannot create
 * them); Chrome reads the file from it while the document stays open.
 *
 * - The file goes to the Downloads folder under the task's name; if a file of
 *   that name exists, Chrome adds " (1)" (`uniquify`), so nothing is
 *   overwritten.
 * - `saveAs: false`: no file dialog, the download runs in the background like
 *   the rest of the task (Chrome may still ask if the user turned on "Ask where
 *   to save each file").
 */
export const chromeFileSaver: FileSaver = {
  save: ({ url, fileName }) => chrome.downloads.download({ url, filename: fileName, conflictAction: 'uniquify', saveAs: false }),
  find: async (downloadId) => {
    const [item] = await chrome.downloads.search({ id: downloadId });
    if (!item) return undefined;
    return {
      state: item.state,
      path: item.filename,
      bytes: item.fileSize > 0 ? item.fileSize : Math.max(item.totalBytes, item.bytesReceived),
      ...(item.error !== undefined ? { error: item.error } : {}),
      // Progressive files (0.3.0): onChanged reports no progress, so it is read from here.
      received: item.bytesReceived,
      ...(item.totalBytes > 0 ? { total: item.totalBytes } : {}),
      canResume: item.canResume,
      ...(item.mime ? { mime: item.mime } : {}),
    };
  },
  cancel: async (downloadId) => {
    await chrome.downloads.cancel(downloadId);
  },
  resume: async (downloadId) => {
    await chrome.downloads.resume(downloadId);
  },
  removeFile: async (downloadId) => {
    await chrome.downloads.removeFile(downloadId);
  },
};
