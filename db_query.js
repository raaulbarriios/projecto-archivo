const { Pool } = require('pg');
const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'postgres',
    password: '1234',
    port: 5432,
});
async function run() {
    try {
        const resNotes = await pool.query("SELECT * FROM notes LIMIT 10;");
        console.log("NOTES:");
        console.log(JSON.stringify(resNotes.rows, null, 2));
        
        const resRecords = await pool.query("SELECT section, file, sheet, row_num FROM records LIMIT 10;");
        console.log("\nRECORDS:");
        console.log(JSON.stringify(resRecords.rows, null, 2));
    } catch (e) {
        console.error(e);
    } finally {
        process.exit(0);
    }
}
run();
