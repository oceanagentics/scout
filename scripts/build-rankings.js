import {readFile,writeFile} from 'node:fs/promises';

const markdown=await readFile(new URL('../shared/rankings.md',import.meta.url),'utf8');
await writeFile(new URL('../shared/rankings.generated.js',import.meta.url),
  '// Generated from rankings.md. Do not edit.\n'+
  'export const RANKING_INSTRUCTION = '+JSON.stringify(markdown)+';\n');
