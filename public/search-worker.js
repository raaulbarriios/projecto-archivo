// Importa las bibliotecas necesarias para gestionar IndexedDB (Dexie) y leer archivos Excel (XLSX)
importScripts('https://unpkg.com/dexie@latest/dist/dexie.js');
importScripts('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js');

let workerNotes = {}; // Almacena las notas de la barra lateral para poder buscar en ellas

/**
 * ESQUEMA DE LA BASE DE DATOS DEL ARCHIVO
 * Optimizado para bajo uso de RAM y búsquedas indexadas de alta velocidad.
 * Los datos se persisten en IndexedDB para no tener que recargarlos en cada sesión.
 */
const db = new Dexie("ArchivoDB");
db.version(2).stores({
    // Estructura de la tabla 'records': ++id (autoincremental), file (nombre del archivo), etc.
    // *searchWords es un índice multi-entrada para búsquedas rápidas por palabras.
    records: '++id, file, sheet, row, titulo, autor, isbn, estado, *searchWords'
});

// Manejador de mensajes que recibe instrucciones desde el hilo principal (app.js)
onmessage = async function(e) {
    const { type, payload } = e.data;

    // CARGA DE NOTAS DE LA BARRA LATERAL
    if (type === 'LOAD_NOTES') {
        workerNotes = payload || {};
        return;
    }

    // CARGA DE ARCHIVOS BRUTOS (Excel, CSV, etc.)
    if (type === 'LOAD_FILES') {
        const { files, isLocalFiles } = payload;
        await db.records.clear(); // Limpia la base de datos actual antes de cargar nuevos archivos
        for (const fileData of files) {
            try {
                let arrayBuffer, fileName;
                if (isLocalFiles) {
                    // Carga desde un objeto File (subida local)
                    arrayBuffer = await fileData.arrayBuffer();
                    fileName = fileData.name;
                } else {
                    // Carga desde una URL del servidor
                    const response = await fetch(`/data/${encodeURIComponent(fileData)}`);
                    arrayBuffer = await response.arrayBuffer();
                    fileName = fileData;
                }

                // Lee el libro de Excel (workbook)
                const workbook = XLSX.read(arrayBuffer, { type: 'array' });
                for (const sheetName of workbook.SheetNames) {
                    const sheet = workbook.Sheets[sheetName];
                    // Convierte la hoja a una matriz de filas (JSON)
                    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
                    if (rows.length < 2) continue; // Salta hojas vacías
                    
                    const headers = rows[0] || [];
                    const batch = []; // Acumulador para inserciones masivas (mejor rendimiento)
                    const colMap = getColMap(headers); // Identifica columnas clave automáticamente

                    for (let i = 1; i < rows.length; i++) {
                        const row = rows[i];
                        if (!row || row.every(c => c === "")) continue; // Salta filas vacías
                        const record = createRecord(fileName, sheetName, i + 1, row, headers, colMap);
                        batch.push(record);
                        
                        // Inserta en bloques de 500 para no bloquear el Worker
                        if (batch.length >= 500) {
                            await db.records.bulkAdd(batch);
                            batch.length = 0;
                        }
                    }
                    if (batch.length > 0) await db.records.bulkAdd(batch);
                }
            } catch (err) {
                console.error(`Error en el Worker:`, err);
            }
        }
        await sendReadyMessage(); // Notifica que la carga ha terminado
    }

    // CARGA DESDE ÍNDICE JSON OPTIMIZADO (Rápido)
    if (type === 'LOAD_JSON') {
        const { url } = payload;
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error("Error al obtener el índice");
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
            console.error("Error cargando JSON:", err);
            postMessage({ type: 'READY', payload: { totalRecords: 0, error: err.message } });
        }
    }

    // Función auxiliar para mapear columnas comunes (título, autor, etc.)
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

    // Crea un objeto de registro estandarizado para guardar en IndexedDB
    function createRecord(fileName, sheetName, rowNum, rowArray, headers, colMap) {
        const record = {
            file: fileName,
            sheet: sheetName,
            row: rowNum,
            data: {}, // Datos brutos de la fila
            titulo: colMap.titulo !== -1 ? String(rowArray[colMap.titulo] || "") : "",
            autor: colMap.autor !== -1 ? String(rowArray[colMap.autor] || "") : "",
            isbn: colMap.isbn !== -1 ? String(rowArray[colMap.isbn] || "") : "",
            estado: colMap.estado !== -1 ? String(rowArray[colMap.estado] || "") : "",
            searchWords: [] // Palabras normalizadas para búsqueda
        };

        const allText = [];
        headers.forEach((colName, colIdx) => {
            const val = rowArray[colIdx];
            if (val !== undefined && val !== null && val !== "") {
                const strVal = String(val);
                record.data[colName || `Columna ${colIdx+1}`] = val;
                allText.push(strVal.toLowerCase());
            }
        });
        // Extrae palabras únicas de más de 2 caracteres para el índice de búsqueda
        record.searchWords = [...new Set(allText.join(' ').split(/[\s,.;:()\-]+/).filter(w => w.length > 0))];
        return record;
    }

    // Normaliza el texto eliminando acentos y convirtiendo a minúsculas
    const normalizeText = (str) => {
        if (!str) return "";
        return String(str)
            .normalize('NFD') // Descompone caracteres combinados (tildes)
            .replace(/[\u0300-\u036f]/g, '') // Elimina los acentos
            .toLowerCase()
            .trim();
    };

    // LÓGICA DE BÚSQUEDA
    if (type === 'SEARCH') {
        const { query, filters, offset = 0, limit = 50 } = payload;
        const normQuery = normalizeText(query);
        const queryWords = normQuery.split(/\s+/).filter(w => w.length > 0);
        
        try {
            let queryChain = db.records;

            // Aplica filtros avanzados si están presentes
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
                        const id = `${r.file}-${r.sheet}-${r.row}`;
                        const notes = workerNotes[id] || {};
                        const notesText = normalizeText(Object.values(notes).join(' '));
                        
                        return rowText.includes(normDoc) || notesText.includes(normDoc);
                    });
                }
            }

            let results = [];
            if (!normQuery) {
                // Si no hay texto de búsqueda, solo devuelve los registros paginados
                results = await queryChain.offset(offset).limit(limit).toArray();
            } else {
                // Búsqueda multi-palabra: todas las palabras de la búsqueda deben estar en el registro
                results = await queryChain
                    .filter(r => {
                        const allText = normalizeText(Object.values(r.data).join(' '));
                        const id = `${r.file}-${r.sheet}-${r.row}`;
                        const notes = workerNotes[id] || {};
                        const notesText = normalizeText(Object.values(notes).join(' '));
                        const combinedText = allText + " " + notesText;
                        
                        return queryWords.length > 0 && queryWords.every(qw => combinedText.includes(qw));
                    })
                    .offset(offset)
                    .limit(limit)
                    .toArray();
            }
            
            // Mapea los resultados internos a un formato apto para la interfaz de usuario
            const mappedResults = results.map(r => ({
                ...r.data,
                __meta: {
                    file: r.file,
                    sheet: r.sheet,
                    row: r.row,
                    type: 'spreadsheet'
                }
            }));
            
            // Envía los resultados de vuelta a app.js
            postMessage({ type: 'SEARCH_RESULTS', payload: mappedResults, meta: { query, offset } });
        } catch (err) {
            console.error("Error en la búsqueda:", err);
        }
    }
};

// Notifica al hilo principal que el Worker está listo y envía estadísticas básicas
async function sendReadyMessage() {
    const total = await db.records.count();
    const files = await db.records.orderBy('file').uniqueKeys();
    postMessage({ type: 'READY', payload: { totalRecords: total, files: files } });
}
