/** Loads a small fictional dataset into an empty database: `npm run demo-data`. */
import { loadConfig } from '../config';
import { loadDotEnv } from '../dotenv';
import { Db } from '../db';
import { migrate } from '../migrations';
import { seedDemoData } from '../services/demo-data';

loadDotEnv();

const config = loadConfig();
const db = new Db(config.dbPath);
migrate(db);
const existing = db.scalar<number>('SELECT (SELECT COUNT(*) FROM account) + (SELECT COUNT(*) FROM expense) + (SELECT COUNT(*) FROM payee)');
if (existing > 0) {
  console.error(`${config.dbPath} already has data; demo data is only loaded into an empty database.`);
  process.exit(1);
}
seedDemoData(db);
db.close();
console.log(`Loaded demo data into ${config.dbPath}.`);
