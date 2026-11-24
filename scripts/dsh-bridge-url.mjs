#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { discoverBridgeOrigin } from '../bridge-discovery.mjs';

const tokenFile = process.env.TASK_BRIDGE_TOKEN_FILE || join(homedir(), '.dsh', 'task-bridge-token');
try {
  const origin = process.env.TASK_BRIDGE_URL?.replace(/\/+$/, '') || await discoverBridgeOrigin(tokenFile);
  process.stdout.write(`${origin}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
