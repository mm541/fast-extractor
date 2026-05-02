/**
 * Utility functions shared across App UI components.
 */

/** Convert milliseconds to HH:MM:SS */
export function formatMs(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Clean up OPFS .app_artifacts directory */
export async function cleanupAppStorage(): Promise<void> {
    if (!navigator.storage?.getDirectory) return;
    try {
      const opfsRoot = await navigator.storage.getDirectory();
      let artifactsDir: FileSystemDirectoryHandle;
      try {
        artifactsDir = await opfsRoot.getDirectoryHandle('.app_artifacts');
      } catch {
        return; // folder doesn't exist — nothing to clean
      }
      const entries: string[] = [];
      // @ts-ignore — OPFS entries()
      for await (const [name] of (artifactsDir as any).entries()) {
        entries.push(name);
      }
      await Promise.all(entries.map(async (name) => {
        try {
          if (navigator.locks) {
            await navigator.locks.request(
              `app_${name}`, { ifAvailable: true },
              async (lock) => {
                if (lock) await artifactsDir.removeEntry(name);
              }
            );
          } else {
            await artifactsDir.removeEntry(name);
          }
        } catch {}
      }));
    } catch (e) {
      console.warn('[App] cleanupAppStorage failed:', e);
    }
}
