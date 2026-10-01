import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CDP_PORT, isCdpUp, launchMiniMaxCode } from '../sidecar.mjs';

export async function main() {
  if (await isCdpUp(CDP_PORT)) {
    console.log(`[launch] CDP endpoint already available on ${CDP_PORT}; no process was started or stopped.`);
    return;
  }
  const launched = await launchMiniMaxCode({ port: CDP_PORT });
  await launched.waitReady();
  console.log(`[launch] Owned process ${launched.pid} is ready on fixed CDP port ${CDP_PORT}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error('[launch] FATAL:', error.message); process.exitCode = 1; });
}
