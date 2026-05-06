const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

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

// Function to load all Excel files and parse them to memoryDB
function loadExcelData() {
    memoryDB = []; // Clear current db
    console.log("Reading Excel files from:", DATA_DIR);
    
    fs.readdir(DATA_DIR, (err, files) => {
        if (err) {
            console.error("Error reading data folder", err);
            return;
        }

        files.forEach(file => {
            if (file.endsWith('.xlsx') || file.endsWith('.xls')) {
                const filePath = path.join(DATA_DIR, file);
                try {
                    const workbook = xlsx.readFile(filePath);
                    
                    // Iterate through all sheets
                    workbook.SheetNames.forEach(sheetName => {
                        const sheet = workbook.Sheets[sheetName];
                        // Get data as JSON array
                        const sheetData = xlsx.utils.sheet_to_json(sheet, { defval: "" });
                        
                        sheetData.forEach(row => {
                            // Add metadata about from where it came
                            row.__meta = {
                                file: file,
                                sheet: sheetName
                            };
                            memoryDB.push(row);
                        });
                    });
                    console.log(`Loaded ${file} successfully.`);
                } catch (e) {
                    console.error(`Error processing file ${file}:`, e);
                }
            }
        });
        
        console.log(`Total records loaded in memory: ${memoryDB.length}`);
    });
}

// Load data initially
loadExcelData();

// Endpoint to refresh data (if they drop a new file and want to update without restarting)
app.get('/api/refresh', (req, res) => {
    loadExcelData();
    res.json({ message: "Data reloaded successfully", totalRecords: memoryDB.length });
});

// Search endpoint
app.get('/api/search', (req, res) => {
    const query = req.query.q;
    
    if (!query) {
        return res.json([]);
    }

    const lowerQuery = query.toLowerCase();
    const results = memoryDB.filter(record => {
        // Search in all values of the object
        return Object.values(record).some(value => 
            String(value).toLowerCase().includes(lowerQuery)
        );
    });

    res.json(results);
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    console.log("Drop Excel files into the /data/ folder and they will be indexed.");
});
