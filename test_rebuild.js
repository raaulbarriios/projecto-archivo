const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const AdmZip = require('adm-zip');

const file = 'Notarios (1).odb';
const filePath = path.join(__dirname, 'data', file);

console.log(`Processing LibreOffice Base: ${file}`);
const tempDir = path.join(__dirname, 'temp_odb_' + Date.now());
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

try {
    const zip = new AdmZip(filePath);
    zip.extractAllTo(tempDir, true);
    
    const dbFolderPath = path.join(tempDir, 'database');
    if (fs.existsSync(dbFolderPath)) {
        const scriptPath = path.join(dbFolderPath, 'script');
        const propertiesPath = path.join(dbFolderPath, 'properties');
        const dataPath = path.join(dbFolderPath, 'data');
        const backupPath = path.join(dbFolderPath, 'backup');
        
        if (fs.existsSync(scriptPath)) fs.renameSync(scriptPath, path.join(dbFolderPath, 'db.script'));
        if (fs.existsSync(propertiesPath)) fs.renameSync(propertiesPath, path.join(dbFolderPath, 'db.properties'));
        if (fs.existsSync(dataPath)) fs.renameSync(dataPath, path.join(dbFolderPath, 'db.data'));
        if (fs.existsSync(backupPath)) fs.renameSync(backupPath, path.join(dbFolderPath, 'db.backup'));
        
        const cpSeparator = process.platform === 'win32' ? ';' : ':';
        const javaCmd = `java -Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8 -cp "lib/hsqldb.jar${cpSeparator}." ReadOdb "${path.join(dbFolderPath, 'db')}"`;
        console.log("Running:", javaCmd);
        const rawBuffer = execSync(javaCmd, { cwd: __dirname, encoding: 'buffer', maxBuffer: 1024 * 1024 * 50 });
        const output = rawBuffer.toString('utf8');
        console.log("Java Output Length:", output.length);
        const tablesData = JSON.parse(output);
        console.log("Parsed records:", tablesData.length);
        // Print first record to check accented characters
        if (tablesData.length > 0) console.log("Sample record:", JSON.stringify(tablesData[0], null, 2));
    } else {
        console.log("No database folder in ZIP");
    }
} catch (e) {
    console.error("Error:", e);
} finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
}
