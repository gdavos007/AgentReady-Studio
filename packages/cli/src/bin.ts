#!/usr/bin/env node
/**
 * The `agentgrade` binary.
 *
 * Deliberately separate from `cli.ts`: the CLI's logic is also exported from
 * the package's library entry, and a module that runs itself on import would
 * make `import '@agentgrade/cli'` execute an audit and set the process exit
 * code. Executable behaviour lives here, where only the `bin` entry reaches it.
 */

import { run } from './cli.js';

void run();
