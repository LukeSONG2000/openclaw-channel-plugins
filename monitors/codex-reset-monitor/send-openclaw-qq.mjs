#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { normalizeManifest, readReceipt, runManifest } from './sender-manifest.mjs';
import { loadTransport } from './sender-transport.mjs';

const publicErrors = new Set(['invalid_manifest', 'invalid_part', 'invalid_text', 'invalid_link',
  'invalid_image', 'batch_too_large', 'image_changed_during_read', 'receipt_required', 'invalid_receipt',
  'receipt_manifest_mismatch', 'receipt_target_mismatch', 'receipt_image_mismatch', 'receipt_locked', 'invalid_target',
  'legacy_manifest_requires_reconciliation', 'legacy_receipt_requires_reconciliation',
  'receipt_delivery_mismatch', 'invalid_delivery_policy',
  'administrator_unavailable', 'plugin_api_unavailable']);

function output(value) {
  process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
}

export async function main(argv = process.argv.slice(2)) {
  let batchId = null;
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
      manifest: { type: 'string' }, receipt: { type: 'string' },
      'dry-run': { type: 'boolean', default: false }, root: { type: 'string' },
      'diagnostic-unverified-images': { type: 'boolean', default: false },
    } });
    const imageVerification = values['diagnostic-unverified-images'] ? 'diagnostic_unverified' : 'strict';
    if (values.manifest) {
      if (positionals.length || !values.receipt) throw new Error('receipt_required');
      const manifestFile = path.resolve(values.manifest);
      const receiptPath = path.resolve(values.receipt);
      const plan = await normalizeManifest(JSON.parse(await fs.readFile(manifestFile, 'utf8')), path.dirname(manifestFile));
      batchId = plan.batchId;
      if (manifestFile === receiptPath) throw new Error('invalid_receipt');
      // Reject legacy evidence before importing SDKs or reading credentials.
      await readReceipt(receiptPath, plan, undefined, imageVerification);
      const transport = values['dry-run'] ? null : await loadTransport(values.root, {
        forceVerifyImageResource: !values['diagnostic-unverified-images'],
      });
      const result = await runManifest({ plan, receiptPath, transport, dryRun: values['dry-run'], imageVerification });
      output(result);
      return result.ok || result.status === 'dry_run' ? 0 : result.status === 'blocked' ? 5 : 4;
    }
    if (values.receipt) throw new Error('invalid_manifest');
    if (values['diagnostic-unverified-images']) throw new Error('invalid_delivery_policy');
    // Preserve positional pure-text alerts, but never fall back to another target.
    const message = positionals.join(' ').trim();
    if (!message) return 2;
    if (values['dry-run']) {
      output({ version: 2, ok: false, status: 'dry_run', message: { status: 'pending' } });
      return 0;
    }
    const transport = await loadTransport(values.root);
    const deliver = await transport.prepareText(message);
    const response = await deliver();
    if (!response?.id) throw new Error('delivery_unknown');
    output('administrator-c2c');
    return 0;
  } catch (error) {
    const errorCode = publicErrors.has(error.message) ? error.message : 'sender_failed';
    output({ version: 2, ok: false, batchId, status: 'blocked', errorCode });
    return errorCode === 'administrator_unavailable' ? 3 : 4;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  // The plugin upload cache also logs directly. Keep stdout machine-readable and
  // suppress dependency diagnostics that may include targets or sensitive URLs.
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) console[method] = () => {};
  process.exitCode = await main();
}
