#!/usr/bin/env node
'use strict';

const { main } = require('../../src/xmux/workflow-cli');

main(process.argv.slice(2))
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error(`xmux workflow: ${error && error.message ? error.message : String(error)}`);
    process.exitCode = 1;
  });
