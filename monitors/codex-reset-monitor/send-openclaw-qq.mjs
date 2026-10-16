#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const proactiveModule = path.join(os.homedir(), '.openclaw/extensions/openclaw-qqbot/dist/src/proactive.js');
const { sendProactive } = await import(pathToFileURL(proactiveModule).href);

const message = process.argv.slice(2).join(' ').trim();
if (!message) {
  console.error('message is required');
  process.exit(2);
}

const configPath = path.join(os.homedir(), '.openclaw/openclaw.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const runtime = config?.channels?.qqbot?.customRuntime ?? {};
const admins = Array.isArray(runtime.admins) ? runtime.admins.filter(Boolean) : [];
const adminGroup = typeof runtime.adminGroup === 'string'
  ? runtime.adminGroup.replace(/^qqbot:group:/, '')
  : '';

const targets = [
  ...admins.map(id => ({ type: 'c2c', id, label: `qqbot:c2c:${id}` })),
  ...(adminGroup ? [{ type: 'group', id: adminGroup, label: `qqbot:group:${adminGroup}` }] : []),
];

if (targets.length === 0) {
  console.error('OpenClaw QQBot administrator target is not configured');
  process.exit(3);
}

for (const target of targets) {
  try {
    const result = await sendProactive(
      { to: target.id, text: message, type: target.type, accountId: 'default' },
      config,
    );
    if (result.success) {
      console.log(target.label);
      process.exit(0);
    }
    console.error(`${target.label}: ${result.error || 'send failed'}`);
  } catch (error) {
    console.error(`${target.label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

process.exit(4);
