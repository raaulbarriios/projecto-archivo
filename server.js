const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const MDBReader = require('mdb-reader');
const { exec } = require('child_process');



const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const DATA_DIR = path.join(__dirname, 'data');
let memoryDB = [];

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR);
}

// Endpoint to list files in the data directory
app.get('/api/files', (req, res) => {
    fs.readdir(DATA_DIR, (err, files) => {
        if (err) return res.status(500).json({ error: "Error reading data folder" });
        
        const supportedFiles = files.filter(file => {
            const ext = path.extname(file).toLowerCase();
            return ['.xlsx', '.xls', '.csv', '.ods', '.accdb', '.mdb'].includes(ext);
        });
        
        res.json({ files: supportedFiles });
    });
});

// Serve the data directory as static so the frontend can fetch the files
app.use('/data', express.static(DATA_DIR));
// Also serve an images directory if it exists
const IMAGES_DIR = path.join(__dirname, 'imagenes');
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR);
app.use('/imagenes', express.static(IMAGES_DIR));

const JSON_CACHE_FILE = path.join(__dirname, 'public', 'data_index.json');

// Endpoint to rebuild the JSON index
app.post('/api/rebuild-index', (req, res) => {
    console.log("Rebuilding index...");
    try {
        const files = fs.readdirSync(DATA_DIR);
        const allRecords = [];

        files.forEach(file => {
            const filePath = path.join(DATA_DIR, file);
            const ext = path.extname(file).toLowerCase();

            try {
                if (['.xlsx', '.xls', '.csv', '.ods'].includes(ext)) {
                    console.log(`Processing Spreadsheet: ${file}`);
                    const workbook = xlsx.readFile(filePath);
                    workbook.SheetNames.forEach(sheetName => {
                        const sheet = workbook.Sheets[sheetName];
                        const data = xlsx.utils.sheet_to_json(sheet);
                        data.forEach((row, index) => {
                            allRecords.push({
                                file: file,
                                sheet: sheetName,
                                row: index + 2, 
                                data: row
                            });
                        });
                    });
                } else if (['.accdb', '.mdb'].includes(ext)) {
                    console.log(`Processing Access: ${file}`);
                    const buffer = fs.readFileSync(filePath);
                    const reader = new MDBReader(buffer);
                    reader.getTableNames().forEach(tableName => {
                        const table = reader.getTable(tableName);
                        const rows = table.getData();
                        rows.forEach((row, index) => {
                            allRecords.push({
                                file: file,
                                sheet: tableName,
                                row: index + 1,
                                data: row
                            });
                        });
                    });
                }
            } catch (fileError) {
                console.error(`Error processing file ${file}:`, fileError);
            }
        });

        fs.writeFileSync(JSON_CACHE_FILE, JSON.stringify(allRecords));
        console.log(`Index rebuilt successfully with ${allRecords.length} records.`);
        res.json({ success: true, count: allRecords.length });
    } catch (error) {
        console.error("Index rebuild error:", error);
        res.status(500).json({ error: error.message });
    }
});

// Endpoint to check if index exists
app.get('/api/index-status', (req, res) => {
    if (fs.existsSync(JSON_CACHE_FILE)) {
        const stats = fs.statSync(JSON_CACHE_FILE);
        res.json({ exists: true, size: stats.size, mtime: stats.mtime });
    } else {
        res.json({ exists: false });
    }
});


// Endpoint to serve a file by its path (useful for absolute paths if needed)
app.get('/api/file', (req, res) => {
    const requestedPath = req.query.path;
    if (!requestedPath) return res.status(400).send('Path parameter is required');

    let fullPath = requestedPath;
    if (!path.isAbsolute(requestedPath)) {
        fullPath = path.resolve(DATA_DIR, requestedPath);
    }

    if (fs.existsSync(fullPath)) {
        if (fs.lstatSync(fullPath).isDirectory()) {
            return res.status(400).send('Cannot serve a directory');
        }
        res.sendFile(fullPath);
    } else {
        res.status(404).send('File not found: ' + requestedPath);
    }
});

// Endpoint to OPEN a file or folder natively on the host machine
app.get('/api/open-file', (req, res) => {
    const requestedPath = req.query.path;
    if (!requestedPath) return res.status(400).send('Path parameter is required');

    let fullPath = requestedPath;
    // Handle relative paths relative to data dir if not absolute
    if (!path.isAbsolute(requestedPath) && !requestedPath.includes(':')) {
        fullPath = path.resolve(DATA_DIR, requestedPath);
    }

    console.log(`Attempting to open: ${fullPath}`);

    if (fs.existsSync(fullPath)) {
        // Command depends on OS
        const command = process.platform === 'win32' ? 'start ""' : 
                        process.platform === 'darwin' ? 'open' : 'xdg-open';
        
        // Wrap in quotes to handle spaces
        exec(`${command} "${fullPath}"`, (error) => {
            if (error) {
                console.error(`Error opening file: ${error}`);
                return res.status(500).send('Could not open file');
            }
            res.send('Opening file...');
        });
    } else {
        res.status(404).send('File or folder not found: ' + fullPath);
    }
});


app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log("Backend simplified. Frontend now handles data indexing via Web Workers.");
});
