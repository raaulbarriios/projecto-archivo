importScripts('https://unpkg.com/dexie@latest/dist/dexie.js');
importScripts('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js');

/**
 * ARCHIVE DATABASE SCHEMA
 * Optimized for low RAM usage and high-speed indexed searches.
 * Data is persisted in IndexedDB so it doesn't need to be reloaded every time.
 */
const db = new Dexie("ArchivoDB");
db.version(2).stores({
    records: '++id, file, sheet, row, titulo, autor, isbn, estado, *searchWords'
});

onmessage = async function(e) {
    const { type, payload } = e.data;

    if (type === 'LOAD_FILES') {
        const { files, isLocalFiles } = payload;
        await db.records.clear();
        for (const fileData of files) {
            try {
                let arrayBuffer, fileName;
                if (isLocalFiles) {
                    arrayBuffer = await fileData.arrayBuffer();
                    fileName = fileData.name;
                } else {
                    const response = await fetch(`/data/${encodeURIComponent(fileData)}`);
                    arrayBuffer = await response.arrayBuffer();
                    fileName = fileData;
                }

                const workbook = XLSX.read(arrayBuffer, { type: 'array' });
                for (const sheetName of workbook.SheetNames) {
                    const sheet = workbook.Sheets[sheetName];
                    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
                    if (rows.length < 2) continue;
                    
                    const headers = rows[0] || [];
                    const batch = [];
                    const colMap = getColMap(headers);

                    for (let i = 1; i < rows.length; i++) {
                        const row = rows[i];
                        if (!row || row.every(c => c === "")) continue;
                        const record = createRecord(fileName, sheetName, i + 1, row, headers, colMap);
                        batch.push(record);
                        if (batch.length >= 500) {
                            await db.records.bulkAdd(batch);
                            batch.length = 0;
                        }
                    }
                    if (batch.length > 0) await db.records.bulkAdd(batch);
                }
            } catch (err) {
                console.error(`Worker error:`, err);
            }
        }
        await sendReadyMessage();
    }

    if (type === 'LOAD_JSON') {
        const { url } = payload;
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error("Failed to fetch index");
            const data = await response.json();
            
            await db.records.clear();
            const batch = [];
            for (const item of data) {
                if (!item.data) continue;
                const headers = Object.keys(item.data);
                const colMap = getColMap(headers);
                const rowArray = headers.map(h => item.data[h]);
                const record = createRecord(item.file, item.sheet, item.row, rowArray, headers, colMap);
                
                batch.push(record);
                if (batch.length >= 1000) {
                    await db.records.bulkPut(batch);
                    batch.length = 0;
                }
            }
            if (batch.length > 0) await db.records.bulkPut(batch);
            
            await sendReadyMessage();
        } catch (err) {
            console.error("Error loading JSON:", err);
            postMessage({ type: 'READY', payload: { totalRecords: 0, error: err.message } });
        }
    }

    function getColMap(headers) {
        const colMap = { titulo: -1, autor: -1, isbn: -1, estado: -1 };
        headers.forEach((h, i) => {
            const lowH = String(h).toLowerCase();
            if (lowH.includes('título') || lowH.includes('titulo') || lowH.includes('nombre') || lowH.includes('title')) colMap.titulo = i;
            if (lowH.includes('autor') || lowH.includes('author')) colMap.autor = i;
            if (lowH.includes('isbn')) colMap.isbn = i;
            if (lowH.includes('estado') || lowH.includes('status')) colMap.estado = i;
        });
        return colMap;
    }

    function createRecord(fileName, sheetName, rowNum, rowArray, headers, colMap) {
        const record = {
            file: fileName,
            sheet: sheetName,
            row: rowNum,
            data: {},
            titulo: colMap.titulo !== -1 ? String(rowArray[colMap.titulo] || "") : "",
            autor: colMap.autor !== -1 ? String(rowArray[colMap.autor] || "") : "",
            isbn: colMap.isbn !== -1 ? String(rowArray[colMap.isbn] || "") : "",
            estado: colMap.estado !== -1 ? String(rowArray[colMap.estado] || "") : "",
            searchWords: []
        };

        const allText = [];
        headers.forEach((h, colIdx) => {
            const val = rowArray[colIdx];
            if (val !== undefined && val !== null && val !== "") {
                const strVal = String(val);
                record.data[h || `Columna ${colIdx+1}`] = val;
                allText.push(strVal.toLowerCase());
            }
        });
        record.searchWords = [...new Set(allText.join(' ').split(/[\s,.;:()\-]+/).filter(w => w.length > 2))];
        return record;
    }

    const normalizeText = (str) => {
        if (!str) return "";
        return String(str)
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .trim();
    };

    if (type === 'SEARCH') {
        const { query, filters, offset = 0, limit = 50 } = payload;
        const normQuery = normalizeText(query);
        const queryWords = normQuery.split(/\s+/).filter(w => w.length > 2);
        
        try {
            let queryChain = db.records;

            // Apply advanced filters if provided
            if (filters) {
                if (filters.file) {
                    queryChain = queryChain.where('file').equals(filters.file);
                }
                if (filters.year) {
                    const yearStr = String(filters.year);
                    queryChain = queryChain.filter(r => {
                        const rowText = Object.values(r.data).join(' ');
                        return rowText.includes(yearStr);
                    });
                }
                if (filters.doc) {
                    const normDoc = normalizeText(filters.doc);
                    queryChain = queryChain.filter(r => {
                        const rowText = normalizeText(Object.values(r.data).join(' '));
                        return rowText.includes(normDoc);
                    });
                }
            }

            let results = [];
            if (!normQuery) {
                results = await queryChain.offset(offset).limit(limit).toArray();
            } else {
                // Combine multi-word search with query chain
                results = await queryChain
                    .filter(r => {
                        const allText = normalizeText(Object.values(r.data).join(' '));
                        return queryWords.every(qw => allText.includes(qw));
                    })
                    .offset(offset)
                    .limit(limit)
                    .toArray();
            }
            
            // Map to frontend format
            const mappedResults = results.map(r => ({
                ...r.data,
                __meta: {
                    file: r.file,
                    sheet: r.sheet,
                    row: r.row,
                    type: 'spreadsheet'
                }
            }));
            
            postMessage({ type: 'SEARCH_RESULTS', payload: mappedResults, meta: { query, offset } });
        } catch (err) {
            console.error("Search error:", err);
        }
    }
};

async function sendReadyMessage() {
    const total = await db.records.count();
    const files = await db.records.orderBy('file').uniqueKeys();
    postMessage({ type: 'READY', payload: { totalRecords: total, files: files } });
}
