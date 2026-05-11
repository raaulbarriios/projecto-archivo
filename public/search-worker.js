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
        const total = await db.records.count();
        postMessage({ type: 'READY', payload: { totalRecords: total } });
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
            
            const total = await db.records.count();
            postMessage({ type: 'READY', payload: { totalRecords: total } });
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

    if (type === 'SEARCH') {
        const { query, offset = 0, limit = 50 } = payload;
        const lowerQuery = query.toLowerCase().trim();
        const queryWords = lowerQuery.split(/\s+/).filter(w => w.length > 0);
        
        try {
            let results = [];
            if (!lowerQuery) {
                results = await db.records.offset(offset).limit(limit).toArray();
            } else {
                // 1. Try indexed search with the first word (very fast)
                results = await db.records
                    .where('searchWords')
                    .startsWith(queryWords[0])
                    .distinct()
                    .toArray();
                
                // 2. Filter these results to ensure they match ALL query words
                if (queryWords.length > 1) {
                    results = results.filter(r => {
                        const allText = Object.values(r.data).join(' ').toLowerCase();
                        return queryWords.every(qw => allText.includes(qw));
                    });
                }

                // 3. Fallback: If not enough results, do a scan (slower but covers everything)
                if (results.length < limit) {
                    const fallbackResults = await db.records
                        .filter(r => {
                            const allText = Object.values(r.data).join(' ').toLowerCase();
                            // Check for exact phrase or all words
                            return allText.includes(lowerQuery) || queryWords.every(qw => allText.includes(qw));
                        })
                        .limit(limit + offset + 50) 
                        .toArray();
                    
                    // Merge and deduplicate
                    const seenIds = new Set(results.map(r => r.id));
                    for (const fr of fallbackResults) {
                        if (!seenIds.has(fr.id)) {
                            results.push(fr);
                        }
                    }
                }
                
                // Sort by relevance (basic: phrase matches first)
                results.sort((a, b) => {
                    const aText = Object.values(a.data).join(' ').toLowerCase();
                    const bText = Object.values(b.data).join(' ').toLowerCase();
                    const aHasPhrase = aText.includes(lowerQuery);
                    const bHasPhrase = bText.includes(lowerQuery);
                    if (aHasPhrase && !bHasPhrase) return -1;
                    if (!aHasPhrase && bHasPhrase) return 1;
                    return 0;
                });

                results = results.slice(offset, offset + limit);
            }

            
            // Map back to the format expected by the frontend
            const mappedResults = results.map(r => ({
                ...r.data,
                __meta: {
                    file: r.file,
                    sheet: r.sheet,
                    row: r.row,
                    headers: Object.keys(r.data),
                    type: 'spreadsheet'
                }
            }));
            
            postMessage({ type: 'SEARCH_RESULTS', payload: mappedResults, meta: { query, offset } });
        } catch (err) {
            console.error("Search error:", err);
        }
    }
};
