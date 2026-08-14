import { migrate, pool } from './db.js';
await migrate();
console.log('Database initialised.');
await pool.end();