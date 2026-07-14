import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Version of the running keel package (dist/ sits next to package.json). */
export function toolVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}
