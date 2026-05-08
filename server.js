const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const MDBReader = require('mdb-reader');


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

// Function to load all supported files and parse them to memoryDB
function loadData() {
    memoryDB = []; // Clear current db
    console.log("Reading data files from:", DATA_DIR);
    
    fs.readdir(DATA_DIR, (err, files) => {
        if (err) {
            console.error("Error reading data folder", err);
            return;
        }

        files.forEach(file => {
            const filePath = path.join(DATA_DIR, file);
            const ext = path.extname(file).toLowerCase();

            // Handle Excel, Calc and CSV files
            if (ext === '.xlsx' || ext === '.xls' || ext === '.ods' || ext === '.csv') {
                let workbook;
                try {
                    console.log(`Intentando leer (modo binario): ${file}...`);
                    const fileBuffer = fs.readFileSync(filePath);
                    workbook = xlsx.read(fileBuffer, { 
                        type: 'buffer',
                        cellNF: false, 
                        cellText: false,
                        cellStyles: false,
                        sheetStubs: true
                    });
                } catch (e) {
                    console.warn(`  ! Fallo inicial en ${file}. Intentando Modo Seguro...`);
                    try {
                        // Segundo intento: Solo lectura de datos puros, sin nada extra
                        const fileBuffer = fs.readFileSync(filePath);
                        workbook = xlsx.read(fileBuffer, { 
                            type: 'buffer',
                            raw: true,
                            nodane: true // Opción interna para saltar algunos nodos
                        });
                    } catch (e2) {
                        console.error(`  X Error crítico en ${file}: No se puede procesar ni en Modo Seguro.`);
                        return; // Siguiente archivo
                    }
                }

                try {
                    workbook.SheetNames.forEach(sheetName => {
                        const sheet = workbook.Sheets[sheetName];
                        // header: 1 returns an array of arrays (rows)
                        const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: "" });
                        
                        if (rows.length === 0) {
                            console.log(`  - Hoja "${sheetName}" está vacía.`);
                            return;
                        }
                        
                        const headers = rows[0] || [];
                        let sheetRecordsCount = 0;
                        
                        // Start from index 1 (skip headers)
                        for (let i = 1; i < rows.length; i++) {
                            const row = rows[i];
                            // Skip completely empty rows
                            if (!row || row.every(cell => cell === null || cell === undefined || cell === "")) continue;

                            const record = {};
                            // Map row data to headers
                            headers.forEach((header, colIdx) => {
                                const key = (header && String(header).trim()) || `Columna ${colIdx + 1}`;
                                let cellValue = row[colIdx];
                                
                                // Si la celda es un error (como #VALOR!), SheetJS a veces devuelve un objeto {t:'e', v:15...}
                                if (cellValue && typeof cellValue === 'object' && cellValue.t === 'e') {
                                    cellValue = "[Error de celda / Foto]"; 
                                }
                                
                                record[key] = cellValue;
                            });

                            record.__meta = {
                                file: file,
                                sheet: sheetName,
                                type: 'spreadsheet',
                                row: i + 1,
                                headers: headers
                            };
                            memoryDB.push(record);
                            sheetRecordsCount++;
                        }
                        console.log(`  - Hoja "${sheetName}": ${sheetRecordsCount} registros cargados.`);
                    });
                    console.log(`Cargado exitosamente: ${file}`);
                } catch (e) {
                    console.error(`Error procesando archivo ${file}:`, e.message);
                }
            } 
            // Handle Access Database files
            else if (ext === '.mdb' || ext === '.accdb') {
                try {
                    const buffer = fs.readFileSync(filePath);
                    const reader = new MDBReader(buffer);
                    
                    const tableNames = reader.getTableNames();
                    tableNames.forEach(tableName => {
                        const table = reader.getTable(tableName);
                        const tableData = table.getData();
                        
                        tableData.forEach((row, index) => {
                            row.__meta = {
                                file: file,
                                table: tableName,
                                type: 'database',
                                row: index + 1 // Row in table
                            };
                            memoryDB.push(row);
                        });
                    });
                    console.log(`Loaded database ${file} successfully.`);
                } catch (e) {
                    console.error(`Error processing database ${file}:`, e);
                }
            }
        });
        
        console.log(`Total records loaded in memory: ${memoryDB.length}`);
    });
}

// Load data initially
loadData();

// Endpoint to refresh data
app.get('/api/refresh', (req, res) => {
    loadData();
    res.json({ message: "Data reloaded successfully", totalRecords: memoryDB.length });
});

// Search endpoint
app.get('/api/search', (req, res) => {
    const query = req.query.q;
    
    if (!query) {
        return res.json([]);
    }

    const lowerQuery = query.toLowerCase();
    const results = [];
    
    // Optimized loop for large datasets
    for (let i = 0; i < memoryDB.length; i++) {
        const record = memoryDB[i];
        let match = false;
        
        for (const key in record) {
            if (key === '__meta') continue;
            const value = record[key];
            if (value && String(value).toLowerCase().includes(lowerQuery)) {
                match = true;
                break;
            }
        }
        
        if (match) {
            results.push(record);
            // Limit results for extremely large matches to prevent browser crash
            if (results.length >= 10000) break;
        }
    }

    res.json(results);
});

// Endpoint to serve a file by its path
app.get('/api/file', (req, res) => {
    const requestedPath = req.query.path;
    if (!requestedPath) return res.status(400).send('Path parameter is required');

    // Handle both absolute and relative paths
    let fullPath = requestedPath;
    if (!path.isAbsolute(requestedPath)) {
        fullPath = path.resolve(DATA_DIR, requestedPath);
    }

    // Security check: only serve if file exists
    if (fs.existsSync(fullPath)) {
        // Optional: Check if it's a directory
        if (fs.lstatSync(fullPath).isDirectory()) {
            return res.status(400).send('Cannot serve a directory');
        }
        res.sendFile(fullPath);
    } else {
        res.status(404).send('File not found: ' + requestedPath);
    }
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log("Drop Excel, ODS or Access files into the /data/ folder and they will be indexed.");
});
