import * as core from '@actions/core';
import { run } from './index.js';

void run().catch((err: unknown) => {
  if (err instanceof Error) {
    core.setFailed(err.message);
  } else {
    core.setFailed(String(err));
  }
});
