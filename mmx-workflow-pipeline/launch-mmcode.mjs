#!/usr/bin/env node
import { parseArgs, createHostApi, startCdpInjector, launchMiniMaxCode, isCdpUp, requireNode22, CDP_PORT, API_PORT } from './sidecar.mjs';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const USAGE = `node launch-mmcode.mjs [--root <dir>]... [--kill-on-exit] [--no-launch]
  --no-launch      attach only; never start or restart MiniMax Code
  --kill-on-exit   stop only a verified process created by this launcher
  API ${API_PORT}; CDP ${CDP_PORT}; occupied ports cause an error, never a fallback`;

export async function main(argv = process.argv.slice(2), operations = {}) {
  requireNode22();
  const args = parseArgs(argv);
  const log = operations.log || ((...items) => console.log('[launch]', ...items));
  if (args.help) { log(USAGE); return; }
  const host = operations.process || process;
  const api = (operations.createHostApi || createHostApi)({ roots: args.roots });
  let launched = null, injector;
  try {
    await api.start(args.apiPort);
    if (!(await (operations.isCdpUp || isCdpUp)(CDP_PORT))) {
      if (args.noLaunch) throw new Error(`CDP_UNAVAILABLE: --no-launch requires MiniMax Code already listening on ${CDP_PORT}. No application was started or stopped.`);
      launched = await (operations.launchMiniMaxCode || launchMiniMaxCode)({ port: CDP_PORT });
      await launched.waitReady();
    }
    injector = (operations.startCdpInjector || startCdpInjector)({ port: CDP_PORT, capability: api.capability });
  } catch (error) {
    try { if (injector) await injector.stop(); } catch {}
    await api.close().catch(() => {});
    throw error;
  }
  let shutdownPromise;
  const shutdown = () => shutdownPromise ||= (async () => {
    host.removeListener('SIGINT', onSignal); host.removeListener('SIGTERM', onSignal);
    const errors = [];
    try { await injector.stop(); } catch (error) { errors.push(error); }
    try { await api.close(); } catch (error) { errors.push(error); }
    if (args.killOnExit && launched) {
      try { await launched.stop(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'Launcher cleanup did not finish completely; unverified applications were not terminated.');
  })();
  const onSignal = () => { shutdown().catch((error) => { console.error('[launch]', error.message); host.exitCode = 1; }); };
  host.on('SIGINT', onSignal); host.on('SIGTERM', onSignal);
  await (operations.sleep || sleep)(2500);
  log(`API: http://127.0.0.1:${args.apiPort}; CDP: ${CDP_PORT}; roots: ${api.roots.join(', ')}`);
  log(`injection: ${injector.target ? 'confirmed target ' + injector.target : 'pending; not yet verified'}`);
  return { api, injector, launched, shutdown };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error('[launch] FATAL:', error.message); process.exitCode = 1; });
}
