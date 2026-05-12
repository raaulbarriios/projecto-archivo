const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const MDBReader = require('mdb-reader');
const { exec, execSync } = require('child_process');
const multer = require('multer');
const AdmZip = require('adm-zip');
const mammoth = require('mammoth');

const NOTES_FILE = path.join(__dirname, 'notes.json');
const ADJUNTOS_DIR = path.join(__dirname, 'adjuntos');
if (!fs.existsSync(NOTES_FILE)) {
    fs.writeFileSync(NOTES_FILE, JSON.stringify({}));
}
if (!fs.existsSync(ADJUNTOS_DIR)) {
    fs.mkdirSync(ADJUNTOS_DIR, { recursive: true });
}




const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const isImage = ['.jpg', '.jpeg', '.png', '.gif'].includes(ext);
        const dest = isImage ? path.join(__dirname, 'imagenes') : path.join(__dirname, 'data');
        if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
        cb(null, dest);
    },
    filename: (req, file, cb) => {
        cb(null, file.originalname);
    }
});
const upload = multer({ storage });

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// File upload endpoint
app.post('/api/upload', upload.array('files'), (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ success: false, error: "No se subieron archivos" });
        }
        res.json({ success: true, count: req.files.length });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});
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
            return ['.xlsx', '.xls', '.csv', '.ods', '.accdb', '.mdb', '.odb'].includes(ext);
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
                } else if (['.odb'].includes(ext)) {
                    console.log(`Processing LibreOffice Base: ${file}`);
                    const tempDir = path.join(__dirname, 'temp_odb_' + Date.now());
                    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
                    
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
                        
                        const javaCmd = `java -Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8 -cp "lib/hsqldb.jar;." ReadOdb "${path.join(dbFolderPath, 'db')}"`;
                        try {
                            const rawBuffer = execSync(javaCmd, { cwd: __dirname, encoding: 'buffer', maxBuffer: 1024 * 1024 * 50 });
                            const output = rawBuffer.toString('utf8');
                            const tablesData = JSON.parse(output);
                            tablesData.forEach((rowObj, index) => {
                                allRecords.push({
                                    file: file,
                                    sheet: rowObj.table,
                                    row: index + 1,
                                    data: rowObj.data
                                });
                            });
                        } catch (err) {
                            console.error(`Error running Java for ${file}:`, err.message);
                        }
                    }
                    fs.rmSync(tempDir, { recursive: true, force: true });
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

// Notes endpoints
app.get('/api/notes', (req, res) => {
    try {
        const notes = JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8'));
        res.json(notes);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/save-note', (req, res) => {
    try {
        const { id, note } = req.body;
        if (!id) return res.status(400).json({ error: "Missing record ID" });
        
        const notes = JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8'));
        notes[id] = note;
        fs.writeFileSync(NOTES_FILE, JSON.stringify(notes, null, 2));
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Attachments endpoints
const attachmentUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            const recordId = req.body.recordId;
            const dest = path.join(ADJUNTOS_DIR, recordId.replace(/[^a-z0-9_-]/gi, '_'));
            if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
            cb(null, dest);
        },
        filename: (req, file, cb) => {
            cb(null, file.originalname);
        }
    })
});

app.post('/api/upload-attachment', attachmentUpload.array('files'), (req, res) => {
    res.json({ success: true, count: req.files.length });
});

app.get('/api/attachments/:id', (req, res) => {
    const recordId = req.params.id.replace(/[^a-z0-9_-]/gi, '_');
    const dest = path.join(ADJUNTOS_DIR, recordId);
    if (!fs.existsSync(dest)) return res.json({ files: [] });
    
    fs.readdir(dest, (err, files) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ files });
    });
});

app.use('/api/adjuntos', express.static(ADJUNTOS_DIR));

app.post('/api/parse-sidebar-file', multer().single('file'), async (req, res) => {
    try {
        const file = req.file;
        if (!file) return res.status(400).json({ error: "No file uploaded" });

        const ext = path.extname(file.originalname).toLowerCase();
        let text = "";

        if (['.xlsx', '.xls', '.csv', '.ods'].includes(ext)) {
            const workbook = xlsx.read(file.buffer, { type: 'buffer' });
            const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
            const rows = xlsx.utils.sheet_to_json(firstSheet, { header: 1 });
            text = rows.map(row => row.join(' ')).join('\n');
        } else if (ext === '.docx') {
            const result = await mammoth.extractRawText({ buffer: file.buffer });
            text = result.value;
        } else if (ext === '.odt') {
            const zip = new AdmZip(file.buffer);
            const contentXml = zip.readAsText("content.xml");
            // Simple regex to extract text from ODT XML
            text = contentXml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
        } else {
            text = file.buffer.toString('utf8');
        }

        // Parse text for KEY: Value pairs
        const data = {};
        const lines = text.split(/\r?\n/);
        const fields = [
            'CODIGO DE REFERENCIA', 'TITULO', 'FECHAS EXTREMAS', 'NIVEL DE DESCRIPCIÓN',
            'VOLUMEN', 'PRODUCTOR', 'RESUMEN', 'CARACTERISTICAS FÍSICAS',
            'DESCRIPTORES TOPOGRÁFICOS', 'DESCRIPTORES ONOMÁSTICOS', 'MATERIAS',
            'NOTAS', 'NOTAS DE PUBLICACIÓN', 'NOTAS DEL ARCHIVERO'
        ];

        lines.forEach(line => {
            const sepIndex = line.indexOf(':');
            if (sepIndex !== -1) {
                const key = line.substring(0, sepIndex).trim().toUpperCase();
                const val = line.substring(sepIndex + 1).trim();
                if (fields.includes(key)) {
                    data[key] = val;
                }
            }
        });

        res.json({ data });
    } catch (error) {
        console.error("Parse Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// Global error handler to ensure JSON responses
app.use((err, req, res, next) => {
    console.error("Server Error:", err);
    res.status(500).json({ success: false, error: err.message || "Error interno del servidor" });
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log("Backend simplified. Frontend now handles data indexing via Web Workers.");
});
