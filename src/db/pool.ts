import pg from 'pg';
import { loadConfig } from '../config.js';

let pool: pg.Pool | undefined;

export function getPool() {
  pool ??= new pg.Pool({ connectionString: loadConfig().DATABASE_URL });
  return pool;
}
