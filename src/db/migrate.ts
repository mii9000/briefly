import { readFile } from 'node:fs/promises';
import { getPool } from './pool.js';

const sql = await readFile(
  new URL('../../sql/001_init.sql', import.meta.url),
  'utf8',
);
await getPool().query(sql);
await getPool().end();
