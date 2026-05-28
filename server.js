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
const chokidar = require('chokidar');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const JWT_SECRET = 'secreto_super_seguro_archivo_central_2026';

const pool = new Pool({
    user: 'bd',
    host: 'localhost',
    database: 'postgres',
    password: '1234',
    port: 5432,
});

async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS records (
                id SERIAL PRIMARY KEY,
                section VARCHAR(255),
                file VARCHAR(255),
                sheet VARCHAR(255),
                row_num INT,
                data JSONB
            )
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS notes (
                id VARCHAR(255) PRIMARY KEY,
                section VARCHAR(255),
                note JSONB
            )
        `);
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                role VARCHAR(20) NOT NULL
            )
        `);

        // Seed default users if none exist
        const userCount = await pool.query('SELECT COUNT(*) FROM users');
        if (parseInt(userCount.rows[0].count) === 0) {
            const adminHash = bcrypt.hashSync('admin', 10);
            const userHash = bcrypt.hashSync('user', 10);
            await pool.query('INSERT INTO users (username, password, role) VALUES ($1, $2, $3)', ['admin', adminHash, 'admin']);
            await pool.query('INSERT INTO users (username, password, role) VALUES ($1, $2, $3)', ['user', userHash, 'user']);
            console.log("Default users created: admin/admin and user/user");
        }

        console.log("PostgreSQL database tables initialized.");
    } catch (err) {
        console.error("Error initializing database:", err);
    }
}
const dbInitPromise = initDB();

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// Auth Middleware
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token == null) return res.status(401).json({ error: "Token requerido" });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: "Token inválido" });
        req.user = user;
        next();
    });
}

function requireAdmin(req, res, next) {
    if (req.user && req.user.role === 'admin') {
        next();
    } else {
        res.status(403).json({ error: "Acceso denegado. Se requiere rol de administrador." });
    }
}

// Login Endpoint
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        
        if (result.rows.length === 0) {
            return res.status(401).json({ error: "Usuario no encontrado" });
        }
        
        const user = result.rows[0];
        const validPassword = bcrypt.compareSync(password, user.password);
        
        if (!validPassword) {
            return res.status(401).json({ error: "Contraseña incorrecta" });
        }
        
        const token = jwt.sign({ username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ token, role: user.role, username: user.username });
    } catch (err) {
        console.error("Login error:", err);
        res.status(500).json({ error: "Error en el servidor" });
    }
});

// Protect all /api routes below this point
app.use('/api', authenticateToken);

// Require admin for any modification route (POST, DELETE, PUT) under /api
app.use('/api', (req, res, next) => {
    if (req.method !== 'GET') {
        return requireAdmin(req, res, next);
    }
    next();
});

// --- User Management Routes ---
app.get('/api/users', requireAdmin, async (req, res) => {
    try {
        const result = await pool.query('SELECT id, username, role FROM users ORDER BY id ASC');
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Error obteniendo usuarios" });
    }
});

app.post('/api/users', async (req, res) => {
    try {
        const { username, password, role } = req.body;
        if (!username || !password || !role) return res.status(400).json({ error: "Faltan datos" });
        const hash = bcrypt.hashSync(password, 10);
        await pool.query('INSERT INTO users (username, password, role) VALUES ($1, $2, $3)', [username, hash, role]);
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        if (err.code === '23505') return res.status(400).json({ error: "El usuario ya existe" });
        res.status(500).json({ error: "Error creando usuario" });
    }
});

app.put('/api/users/:username/password', async (req, res) => {
    try {
        const { username } = req.params;
        const { password } = req.body;
        if (!password) return res.status(400).json({ error: "Se requiere contraseña nueva" });
        const hash = bcrypt.hashSync(password, 10);
        const result = await pool.query('UPDATE users SET password = $1 WHERE username = $2', [hash, username]);
        if (result.rowCount === 0) return res.status(404).json({ error: "Usuario no encontrado" });
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Error actualizando contraseña" });
    }
});

app.delete('/api/users/:username', async (req, res) => {
    try {
        const { username } = req.params;
        if (username === 'admin') {
            return res.status(400).json({ error: "No se puede borrar al administrador principal" });
        }
        const result = await pool.query('DELETE FROM users WHERE username = $1', [username]);
        if (result.rowCount === 0) return res.status(404).json({ error: "Usuario no encontrado" });
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Error borrando usuario" });
    }
});

const SECTIONS = ['ahpna', 'urbanismo', 'ama'];

const BASE_DIRS = {
    data: path.join(__dirname, 'data'),
    adjuntos: path.join(__dirname, 'adjuntos'),
    imagenes: path.join(__dirname, 'imagenes')
};

// Create base and section directories
Object.values(BASE_DIRS).forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    SECTIONS.forEach(section => {
        const sectionDir = path.join(dir, section);
        if (!fs.existsSync(sectionDir)) fs.mkdirSync(sectionDir, { recursive: true });
    });
});

function getValidSection(req) {
    const section = req.query.section || req.body.section;
    if (!SECTIONS.includes(section)) return 'ahpna'; // Default fallback
    return section;
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const section = getValidSection(req);
        const ext = path.extname(file.originalname).toLowerCase();
        const isImage = ['.jpg', '.jpeg', '.png', '.gif'].includes(ext);
        const base = isImage ? BASE_DIRS.imagenes : BASE_DIRS.data;
        const dest = path.join(base, section);
        cb(null, dest);
    },
    filename: (req, file, cb) => {
        const decodedName = Buffer.from(file.originalname, 'latin1').toString('utf8');
        cb(null, decodedName);
    }
});
const upload = multer({ storage });

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

// Endpoint to list files in the data directory
app.get('/api/files', (req, res) => {
    const section = getValidSection(req);
    const dataDir = path.join(BASE_DIRS.data, section);
    const imagenesDir = path.join(BASE_DIRS.imagenes, section);
    const adjuntosDir = path.join(BASE_DIRS.adjuntos, section);

    try {
        const getFiles = (dir) => fs.existsSync(dir) ? fs.readdirSync(dir) : [];
        
        // Data files
        const dataFiles = getFiles(dataDir).filter(file => {
            const ext = path.extname(file).toLowerCase();
            return ['.xlsx', '.xls', '.csv', '.ods', '.accdb', '.mdb', '.odb'].includes(ext);
        });

        // Imagenes (fotos)
        const fotoFiles = getFiles(imagenesDir).filter(file => fs.lstatSync(path.join(imagenesDir, file)).isFile());

        // Notas (adjuntos)
        let notasFiles = [];
        if (fs.existsSync(adjuntosDir)) {
            const records = fs.readdirSync(adjuntosDir);
            records.forEach(recordId => {
                const recordPath = path.join(adjuntosDir, recordId);
                if (fs.lstatSync(recordPath).isDirectory()) {
                    const files = fs.readdirSync(recordPath);
                    files.forEach(f => {
                        notasFiles.push(`${recordId}/${f}`);
                    });
                }
            });
        }

        res.json({ 
            datos: dataFiles,
            fotos: fotoFiles,
            notas: notasFiles
        });
    } catch (err) {
        res.status(500).json({ error: "Error reading folders: " + err.message });
    }
});

// Endpoint to delete a file
app.delete('/api/files', async (req, res) => {
    try {
        const section = getValidSection(req);
        const category = req.query.category || 'datos';
        const filename = req.query.filepath;
        
        if (!category || !filename) return res.status(400).json({error: "Missing parameters"});
        
        let basePath;
        if (category === 'datos') basePath = BASE_DIRS.data;
        else if (category === 'fotos') basePath = BASE_DIRS.imagenes;
        else if (category === 'notas') basePath = BASE_DIRS.adjuntos;
        else return res.status(400).json({error: "Invalid category"});
        
        const filePath = path.resolve(basePath, section, filename);
        
        if (filePath.startsWith(path.resolve(basePath, section)) && fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            
            let recordId = null;
            if (category === 'notas') {
                const parts = filename.split('/');
                if (parts.length > 0) {
                    const normId = parts[0];
                    const dbNotes = await pool.query('SELECT id FROM notes WHERE section = $1', [section]);
                    let realId = normId;
                    for (let row of dbNotes.rows) {
                        if (row.id.replace(/[^a-z0-9_-]/gi, '_') === normId) {
                            realId = row.id;
                            break;
                        }
                    }
                    await pool.query('DELETE FROM notes WHERE id = $1 AND section = $2', [realId, section]);
                    recordId = realId;
                }
            }
            
            res.json({ success: true, message: "File deleted successfully", recordId });
        } else {
            res.status(404).json({ success: false, error: "File not found" });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});



// Serve the directories as static so the frontend can fetch the files
app.use('/data', express.static(BASE_DIRS.data));
app.use('/imagenes', express.static(BASE_DIRS.imagenes));

function extractDataFromSheet(sheet) {
    const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: "" });
    if (rows.length === 0) return [];

    let firstDataRow = 0;
    while (firstDataRow < rows.length && rows[firstDataRow].every(cell => String(cell).trim() === "")) {
        firstDataRow++;
    }
    if (firstDataRow >= rows.length) return [];

    let headerEndIndex = firstDataRow;
    let hitEmptyRow = false;
    for (let i = firstDataRow; i < Math.min(firstDataRow + 5, rows.length); i++) {
        const row = rows[i];
        const isEmpty = row.every(cell => String(cell).trim() === "");
        if (isEmpty) {
            headerEndIndex = i - 1;
            hitEmptyRow = true;
            break;
        }
        const hasNumber = row.some(cell => typeof cell === 'number');
        if (hasNumber && i > firstDataRow) {
            headerEndIndex = i - 1;
            break;
        }
    }

    if (!hitEmptyRow && headerEndIndex === firstDataRow) {
        const row0 = rows[firstDataRow];
        const row1 = rows[firstDataRow + 1];
        if (row1) {
            let row1FillsGaps = false;
            for (let c = 0; c < row1.length; c++) {
                if (String(row0[c] || "").trim() === "" && String(row1[c] || "").trim() !== "") {
                    row1FillsGaps = true;
                    break;
                }
            }
            if (row1FillsGaps) {
                headerEndIndex = firstDataRow + 1;
                const row2 = rows[firstDataRow + 2];
                if (row2) {
                    let row2FillsGaps = false;
                    for (let c = 0; c < row2.length; c++) {
                        if (String(row1[c] || "").trim() === "" && String(row2[c] || "").trim() !== "") {
                            row2FillsGaps = true;
                            break;
                        }
                    }
                    if (row2FillsGaps) headerEndIndex = firstDataRow + 2;
                }
            }
        }
    }

    const combinedHeaders = [];
    const maxCols = Math.max(...rows.slice(firstDataRow, headerEndIndex + 1).map(r => r.length));
    
    for (let c = 0; c < maxCols; c++) {
        const parts = [];
        for (let r = firstDataRow; r <= headerEndIndex; r++) {
            const val = String(rows[r][c] || "").trim();
            if (val) parts.push(val);
        }
        let headerName = parts.join(" ");
        if (!headerName) headerName = `__EMPTY_${c}`;
        combinedHeaders.push(headerName);
    }

    const dataObjects = [];
    let startDataRow = headerEndIndex + 1;
    while (startDataRow < rows.length && rows[startDataRow].every(cell => String(cell).trim() === "")) {
        startDataRow++;
    }

    for (let r = startDataRow; r < rows.length; r++) {
        const row = rows[r];
        if (row.every(cell => String(cell).trim() === "")) continue;
        
        const obj = {};
        for (let c = 0; c < combinedHeaders.length; c++) {
            const val = row[c];
            if (val !== undefined && val !== "") {
                obj[combinedHeaders[c]] = val;
            }
        }
        if (Object.keys(obj).length > 0) {
            dataObjects.push({ _rowNum: r + 1, ...obj });
        }
    }

    return dataObjects;
}

// Function to rebuild the JSON index
async function rebuildIndex(section) {
    console.log(`Rebuilding index for section: ${section}...`);
    try {
        const dataDir = path.join(BASE_DIRS.data, section);
        const files = fs.readdirSync(dataDir);
        const allRecords = [];

        for (const file of files) {
            const filePath = path.join(dataDir, file);
            const ext = path.extname(file).toLowerCase();

            try {
                if (['.xlsx', '.xls', '.csv', '.ods'].includes(ext)) {
                    console.log(`Processing Spreadsheet: ${file}`);
                    const workbook = xlsx.readFile(filePath);
                    workbook.SheetNames.forEach(sheetName => {
                        const sheet = workbook.Sheets[sheetName];
                        const data = extractDataFromSheet(sheet);
                        data.forEach((rowObj) => {
                            const rowNum = rowObj._rowNum;
                            delete rowObj._rowNum;
                            allRecords.push({
                                file: file,
                                sheet: sheetName,
                                row: rowNum,
                                data: rowObj
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
        }

        await pool.query('BEGIN');
        await pool.query('DELETE FROM records WHERE section = $1', [section]);
        const chunkSize = 1000;
        for (let i = 0; i < allRecords.length; i += chunkSize) {
            const chunk = allRecords.slice(i, i + chunkSize);
            const values = [];
            let queryStr = 'INSERT INTO records (section, file, sheet, row_num, data) VALUES ';
            let paramIndex = 1;
            chunk.forEach(record => {
                queryStr += `($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}),`;
                values.push(section, record.file, record.sheet, record.row, record.data);
            });
            queryStr = queryStr.slice(0, -1);
            await pool.query(queryStr, values);
        }
        await pool.query('COMMIT');

        // Clean up orphan notes
        await pool.query(`
            DELETE FROM notes
            WHERE section = $1
            AND id NOT IN (
                SELECT CONCAT(file, '-', sheet, '-', row_num)
                FROM records 
                WHERE section = $1
            )
        `, [section]);

        // Clean up orphan files in adjuntos
        const adjuntosDir = path.join(BASE_DIRS.adjuntos, section);
        if (fs.existsSync(adjuntosDir)) {
            const activeRecordsResult = await pool.query(`
                SELECT CONCAT(file, '-', sheet, '-', row_num) as id
                FROM records WHERE section = $1
            `, [section]);
            const activeNormalized = new Set(activeRecordsResult.rows.map(r => r.id.replace(/[^a-z0-9_-]/gi, '_')));
            
            const folders = fs.readdirSync(adjuntosDir);
            folders.forEach(folder => {
                const folderPath = path.join(adjuntosDir, folder);
                if (fs.lstatSync(folderPath).isDirectory() && !activeNormalized.has(folder)) {
                    fs.rmSync(folderPath, { recursive: true, force: true });
                }
            });
        }

        console.log(`Index rebuilt successfully for ${section} with ${allRecords.length} records.`);
        return allRecords.length;
    } catch (error) {
        console.error(`Index rebuild error for ${section}:`, error);
        throw error;
    }
}

// Endpoint to rebuild the JSON index manually
app.post('/api/rebuild-index', async (req, res) => {
    try {
        const section = getValidSection(req);
        const count = await rebuildIndex(section);
        res.json({ success: true, count: count });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Endpoint to check if index exists
app.get('/api/index-status', async (req, res) => {
    try {
        const section = getValidSection(req);
        const result = await pool.query('SELECT COUNT(*) FROM records WHERE section = $1', [section]);
        const count = parseInt(result.rows[0].count, 10);
        if (count > 0) {
            res.json({ exists: true, size: count * 100, mtime: new Date() });
        } else {
            res.json({ exists: false });
        }
    } catch (error) {
        res.json({ exists: false });
    }
});

// New endpoint to serve data to frontend exactly like the old static file
app.get('/data_index_:section.json', async (req, res) => {
    try {
        const section = req.params.section;
        const result = await pool.query('SELECT file, sheet, row_num as row, data FROM records WHERE section = $1', [section]);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});


// Endpoint to serve a file by its path (useful for absolute paths if needed)
app.get('/api/file', (req, res) => {
    const section = getValidSection(req);
    const requestedPath = req.query.path;
    if (!requestedPath) return res.status(400).send('Path parameter is required');

    let fullPath = requestedPath;
    if (!path.isAbsolute(requestedPath)) {
        fullPath = path.resolve(BASE_DIRS.data, section, requestedPath);
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
    const section = getValidSection(req);
    const requestedPath = req.query.path;
    if (!requestedPath) return res.status(400).send('Path parameter is required');

    let fullPath = requestedPath;
    // Handle relative paths relative to data dir if not absolute
    if (!path.isAbsolute(requestedPath) && !requestedPath.includes(':')) {
        fullPath = path.resolve(BASE_DIRS.data, section, requestedPath);
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
app.get('/api/notes', async (req, res) => {
    try {
        const section = getValidSection(req);
        const result = await pool.query('SELECT id, note FROM notes WHERE section = $1', [section]);
        const notes = {};
        result.rows.forEach(row => {
            notes[row.id] = row.note;
        });
        res.json(notes);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/save-note', async (req, res) => {
    try {
        const section = getValidSection(req);
        const { id, note } = req.body;
        if (!id) return res.status(400).json({ error: "Missing record ID" });

        await pool.query(
            'INSERT INTO notes (id, section, note) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET note = EXCLUDED.note',
            [id, section, note]
        );

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Attachments endpoints
const attachmentUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            const section = getValidSection(req);
            const recordId = req.body.recordId || req.body.id;
            const dest = path.join(BASE_DIRS.adjuntos, section, recordId.replace(/[^a-z0-9_-]/gi, '_'));
            if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
            cb(null, dest);
        },
        filename: (req, file, cb) => {
            const decodedName = Buffer.from(file.originalname, 'latin1').toString('utf8');
            cb(null, decodedName);
        }
    })
});

app.post('/api/upload-attachment', attachmentUpload.array('files'), (req, res) => {
    res.json({ success: true, count: req.files.length });
});

app.get('/api/attachments/:id', (req, res) => {
    const section = getValidSection(req);
    const recordId = req.params.id.replace(/[^a-z0-9_-]/gi, '_');
    const dest = path.join(BASE_DIRS.adjuntos, section, recordId);
    if (!fs.existsSync(dest)) return res.json({ files: [] });

    fs.readdir(dest, (err, files) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ files });
    });
});

app.use('/api/adjuntos', express.static(BASE_DIRS.adjuntos));

app.post('/api/parse-sidebar-file', attachmentUpload.single('file'), async (req, res) => {
    try {
        const file = req.file;
        if (!file) return res.status(400).json({ error: "No file uploaded" });

        file.buffer = fs.readFileSync(file.path);

        const ext = path.extname(file.originalname).toLowerCase();
        let text = "";

        const fields = [
            'CODIGO DE REFERENCIA', 'TITULO', 'FECHAS EXTREMAS', 'NIVEL DE DESCRIPCIÓN',
            'VOLUMEN', 'PRODUCTOR', 'RESUMEN', 'CARACTERISTICAS FÍSICAS',
            'DESCRIPTORES TOPOGRÁFICOS', 'DESCRIPTORES ONOMÁSTICOS', 'MATERIAS',
            'NOTAS', 'NOTAS DE PUBLICACIÓN', 'NOTAS DEL ARCHIVERO'
        ];

        function normalizeKey(str) {
            if (!str) return "";
            let n = String(str).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().trim();
            if (n.startsWith("CARACTERISTICAS FISICA")) n = "CARACTERISTICAS FISICAS";
            if (n === "NOTAS DEL ARCHIVO") n = "NOTAS DEL ARCHIVERO";
            return n;
        }

        const normTargetFields = fields.map(normalizeKey);

        if (['.xlsx', '.xls', '.csv', '.ods'].includes(ext)) {
            const workbook = xlsx.read(file.buffer, { type: 'buffer' });
            const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
            const rows = xlsx.utils.sheet_to_json(firstSheet, { header: 1 });

            let isHorizontal = false;
            if (rows.length >= 2 && rows[0].length > 2) {
                const headerMatches = rows[0].filter(h => h && normTargetFields.includes(normalizeKey(h)));
                if (headerMatches.length >= 2) {
                    isHorizontal = true;
                }
            }

            if (isHorizontal) {
                const headers = rows[0];
                const values = rows[1] || [];
                const linesArr = [];
                for (let i = 0; i < headers.length; i++) {
                    if (headers[i] && values[i]) {
                        linesArr.push(`${headers[i]}: ${values[i]}`);
                    }
                }
                text = linesArr.join('\n');
            } else {
                text = rows.map(row => row.join(': ')).join('\n');
            }
        } else if (ext === '.docx') {
            const result = await mammoth.extractRawText({ buffer: file.buffer });
            text = result.value;
        } else if (ext === '.odt') {
            const zip = new AdmZip(file.buffer);
            const contentXml = zip.readAsText("content.xml");
            text = contentXml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
        } else {
            text = file.buffer.toString('utf8');
        }

        const data = {};
        const lines = text.split(/\r?\n/);

        lines.forEach(line => {
            let key = '';
            let val = '';
            const sepIndex = line.indexOf(':');

            if (sepIndex !== -1) {
                key = line.substring(0, sepIndex).trim();
                val = line.substring(sepIndex + 1).trim();
            } else {
                const foundField = fields.find(f => line.toUpperCase().startsWith(f));
                if (foundField) {
                    key = foundField;
                    val = line.substring(foundField.length).trim();
                }
            }

            if (!key) return;

            let nKey = normalizeKey(key);
            const index = normTargetFields.indexOf(nKey);
            if (index !== -1) {
                data[fields[index]] = val;
            }
        });

        res.json({ data });
    } catch (error) {
        console.error("Parse Error:", error);
        res.status(500).json({ error: error.message });
    }
});

app.use((err, req, res, next) => {
    console.error("Server Error:", err);
    res.status(500).json({ success: false, error: err.message || "Error interno del servidor" });
});

dbInitPromise.then(() => {
    app.listen(PORT, () => {
        console.log(`Server running at http://localhost:${PORT}`);
        console.log("Backend simplified. Frontend now handles data indexing via Web Workers.");

        // Initial rebuild on startup for all sections
        SECTIONS.forEach(section => {
            rebuildIndex(section).catch(err => console.error(`Initial rebuild failed for ${section}:`, err));
        });

        // Setup file watcher for automatic updates
        let debounceTimers = {};
        const watcher = chokidar.watch(BASE_DIRS.data, {
            ignoreInitial: true,
            persistent: true
        });

        watcher.on('all', (event, filePath) => {
            console.log(`File change detected: ${event} on ${filePath}`);

            // Determine which section changed
            const relativePath = path.relative(BASE_DIRS.data, filePath);
            const section = relativePath.split(path.sep)[0];

            if (SECTIONS.includes(section)) {
                clearTimeout(debounceTimers[section]);
                debounceTimers[section] = setTimeout(() => {
                    console.log(`Triggering automatic index rebuild for ${section}...`);
                    rebuildIndex(section).catch(err => console.error(`Automatic rebuild failed for ${section}:`, err));
                }, 2000); // 2 second debounce
            }
        });
    });
});