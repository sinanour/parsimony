import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from './config';

/** Loads the repository's .env (if any) into process.env without overriding variables already set. */
export function loadDotEnv(file = path.join(repoRoot, '.env')): void {
  if (fs.existsSync(file)) process.loadEnvFile(file);
}
