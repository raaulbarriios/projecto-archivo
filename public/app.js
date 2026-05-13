document.addEventListener('DOMContentLoaded', () => {
    const searchInput = document.getElementById('searchInput');
    const clearBtn = document.getElementById('clearBtn');
    const resultsContainer = document.getElementById('resultsContainer');
    const resultCount = document.getElementById('resultCount');
    const refreshBtn = document.getElementById('refreshBtn');
    const rebuildIndexBtn = document.getElementById('rebuildIndexBtn');
    const importBtn = document.getElementById('importBtn');
    const fileInput = document.getElementById('fileInput');
    const notesSidebar = document.getElementById('notesSidebar');
    const sidebarBody = document.getElementById('sidebarBody');
    const closeSidebar = document.getElementById('closeSidebar');
    const sidebarOverlay = document.getElementById('sidebarOverlay');


    // State variables
    let currentRenderIndex = 0;
    const CHUNK_SIZE = 50;
    let currentQuery = "";
    let isWorkerReady = false;
    let isLoadingMore = false;
    let hasMoreResults = true;
    let debounceTimer;
    let recordNotes = {}; // To store fetched notes
    let lastSearchResults = []; // To store results for easy access by index

    // Advanced Search Logic
    const advancedSearchToggle = document.getElementById('advancedSearchToggle');
    const advancedPanel = document.getElementById('advancedPanel');
    const filterYear = document.getElementById('filterYear');
    const filterFile = document.getElementById('filterFile');
    const filterDoc = document.getElementById('filterDoc');

    const searchWorker = new Worker('search-worker.js');

    // UI Events
    advancedSearchToggle.addEventListener('click', () => {
        advancedPanel.classList.toggle('hidden');
        advancedSearchToggle.classList.toggle('active');
    });

    [filterYear, filterFile, filterDoc].forEach(el => {
        const eventType = el.tagName === 'SELECT' ? 'change' : 'input';
        el.addEventListener(eventType, () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                performSearch(searchInput.value.trim());
            }, 300);
        });
    });

    searchInput.addEventListener('input', (e) => {
        const query = e.target.value.trim();
        clearBtn.classList.toggle('hidden', query.length === 0);
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => performSearch(query), 300);
    });

    clearBtn.addEventListener('click', () => {
        searchInput.value = '';
        filterYear.value = '';
        filterDoc.value = '';
        filterFile.value = '';
        clearBtn.classList.add('hidden');
        performSearch("");
    });
    
    // Sidebar closing
    [closeSidebar, sidebarOverlay].forEach(el => {
        el.addEventListener('click', () => {
            notesSidebar.classList.remove('open');
        });
    });


    refreshBtn.addEventListener('click', () => {
        if (refreshBtn.classList.contains('loading')) return;
        refreshBtn.classList.add('loading');
        initData();
    });

    async function triggerRebuild(skipConfirm = false) {
        if (rebuildIndexBtn.classList.contains('loading')) return;
        if (!skipConfirm && !confirm("Esto procesará todos los archivos en el servidor. ¿Continuar?")) return;

        rebuildIndexBtn.classList.add('loading');
        resultCount.textContent = 'Generando índice en servidor...';
        
        try {
            const response = await fetch('/api/rebuild-index', { method: 'POST' });
            const data = await response.json();
            if (data.success) {
                resultCount.textContent = `¡Hecho! ${data.count} registros optimizados.`;
                searchWorker.postMessage({ type: 'LOAD_JSON', payload: { url: '/data_index.json' } });
            }
        } catch (err) {
            resultCount.textContent = 'Error al optimizar.';
        } finally {
            rebuildIndexBtn.classList.remove('loading');
        }
    }

    rebuildIndexBtn.addEventListener('click', () => triggerRebuild(false));

    importBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files);
        if (files.length === 0) return;
        
        importBtn.classList.add('loading');
        resultCount.textContent = `Subiendo ${files.length} archivos al servidor...`;

        const formData = new FormData();
        files.forEach(f => formData.append('files', f));

        try {
            const response = await fetch('/api/upload', {
                method: 'POST',
                body: formData
            });
            const data = await response.json();
            
            if (data.success) {
                resultCount.textContent = `¡Subidos! Procesando e indexando...`;
                // Trigger index rebuild automatically without another confirmation
                triggerRebuild(true);
            } else {
                throw new Error(data.error);
            }
        } catch (err) {
            alert("Error al subir archivos: " + err.message);
            resultCount.textContent = 'Error en la subida.';
        } finally {
            importBtn.classList.remove('loading');
            fileInput.value = ''; // Reset input
        }
    });

    // Worker Communication
    searchWorker.onmessage = (e) => {
        const { type, payload, meta } = e.data;
        
        if (type === 'READY') {
            isWorkerReady = true;
            resultCount.textContent = `Listos. ${payload.totalRecords} registros disponibles.`;
            refreshBtn.classList.remove('loading');
            importBtn.classList.remove('loading');
            if (payload.files) updateFileFilter(payload.files);
            performSearch(searchInput.value.trim());
        } else if (type === 'SEARCH_RESULTS') {
            if (meta.offset === 0) {
                resultsContainer.innerHTML = '';
                lastSearchResults = [];
                if (payload.length === 0) showNoResults();
                else resultCount.textContent = `Mostrando resultados para "${currentQuery || 'todo'}"`;
            }
            lastSearchResults.push(...payload);
            appendResults(payload, meta.offset);
            isLoadingMore = false;
            hasMoreResults = payload.length === CHUNK_SIZE;
            currentRenderIndex += payload.length;
            setupInfiniteScroll();
        }
    };

    function updateFileFilter(files) {
        const current = filterFile.value;
        filterFile.innerHTML = '<option value="">Todos los archivos</option>';
        [...new Set(files)].sort().forEach(f => {
            const opt = document.createElement('option');
            opt.value = f;
            opt.textContent = f;
            filterFile.appendChild(opt);
        });
        filterFile.value = current;
    }

    function performSearch(query) {
        if (!isWorkerReady) return;
        currentQuery = query;
        currentRenderIndex = 0;
        hasMoreResults = true;

        if (!query && !filterYear.value.trim() && !filterFile.value && !filterDoc.value.trim()) {
            resultsContainer.innerHTML = '';
            const emptyState = document.getElementById('emptyState');
            if (emptyState) {
                resultsContainer.appendChild(emptyState);
                emptyState.classList.remove('hidden');
            }
            resultCount.textContent = 'Ingrese un término para buscar.';
            return;
        }

        isLoadingMore = true;

        const filters = {
            year: filterYear.value.trim(),
            file: filterFile.value,
            doc: filterDoc.value.trim()
        };

        resultsContainer.innerHTML = '<div class="spinner"></div>';
        searchWorker.postMessage({ 
            type: 'SEARCH', 
            payload: { query, filters, offset: 0, limit: CHUNK_SIZE } 
        });
    }

    function renderNextChunk() {
        if (!isWorkerReady || isLoadingMore || !hasMoreResults) return;
        isLoadingMore = true;
        
        const filters = {
            year: filterYear.value.trim(),
            file: filterFile.value,
            doc: filterDoc.value.trim()
        };

        searchWorker.postMessage({ 
            type: 'SEARCH', 
            payload: { query: currentQuery, filters, offset: currentRenderIndex, limit: CHUNK_SIZE } 
        });
    }

    function appendResults(results, offset) {
        const fragment = document.createDocumentFragment();
        results.forEach((record, i) => {
            fragment.appendChild(createRecordCard(record, offset + i));
        });
        resultsContainer.appendChild(fragment);
    }

    function extractImageSrc(record) {
        if (!record) return null;
        const displayData = { ...record };
        delete displayData.__meta;

        // Priority 1: Direct path or URL in specific fields
        for (const [key, val] of Object.entries(displayData)) {
            const lowKey = key.toLowerCase();
            if ((lowKey.includes('foto') || lowKey.includes('imagen') || lowKey.includes('ruta')) && val) {
                const cleanVal = String(val).trim();
                return (cleanVal.includes('/') || cleanVal.includes('\\')) 
                    ? `/api/file?path=${encodeURIComponent(cleanVal)}`
                    : `/imagenes/${encodeURIComponent(cleanVal)}`;
            }
        }
        
        // Priority 2: Named match (ID, Name, etc.) + .jpg
        const imgKeys = ['nombre', 'título', 'titulo', 'id', 'pasaporte'];
        for (const [key, val] of Object.entries(displayData)) {
            if (imgKeys.some(k => key.toLowerCase().includes(k)) && val) {
                return `/imagenes/${encodeURIComponent(String(val).trim())}.jpg`;
            }
        }
        return null;
    }

    function createRecordCard(record, index) {
        const meta = record?.__meta || { file: 'Desconocido', sheet: '', row: '?' };
        const displayData = { ...record };
        delete displayData.__meta;

        const card = document.createElement('div');
        card.className = 'record-card';
        
        const imageSrc = extractImageSrc(record);

        let imgHTML = '';
        if (imageSrc) {
            imgHTML = `
                <div class="card-auto-image">
                    <img src="${imageSrc}" 
                         onerror="if(this.src.includes('.jpg')) this.src=this.src.replace('.jpg','.png'); else this.parentElement.style.display='none';"
                         onclick="window.openSidebarByIndex(${index})">
                </div>`;
        }

        let gridHTML = '<div class="data-grid">';
        for (const [key, val] of Object.entries(displayData)) {
            if (!val && val !== 0) continue;
            gridHTML += `
                <div class="data-group">
                    <span class="data-label">${escapeHTML(key)}</span>
                    <span class="data-value">${highlightText(String(val), currentQuery)}</span>
                </div>`;
        }
        gridHTML += '</div>';

        const recordId = `${meta.file}-${meta.sheet || meta.table}-${meta.row}`;
        
        card.innerHTML = `
            <div class="card-content-wrapper">
                <div class="card-image-column">
                    ${imgHTML}
                </div>
                <div class="card-main-info">
                    <div class="card-header">
                        <span class="card-source">📄 ${escapeHTML(meta.file)} - ${escapeHTML(meta.sheet || meta.table || '')}</span>
                        <div class="card-location">📍 Fila: ${meta.row}</div>
                    </div>
                    ${gridHTML}
                </div>
            </div>`;
        return card;
    }

    window.openSidebarByIndex = (index) => {
        const record = lastSearchResults[index];
        if (!record) return;
        const meta = record.__meta;
        const id = `${meta.file}-${meta.sheet || meta.table}-${meta.row}`;
        window.openSidebar(id, record);
    };


    window.openSidebar = (id, record) => {
        const savedData = recordNotes[id] || {};
        const imageSrc = extractImageSrc(record);

        const fields = [
            'CODIGO DE REFERENCIA',
            'TITULO',
            'FECHAS EXTREMAS',
            'NIVEL DE DESCRIPCIÓN',
            'VOLUMEN',
            'PRODUCTOR',
            'RESUMEN',
            'CARACTERISTICAS FÍSICAS',
            'DESCRIPTORES TOPOGRÁFICOS',
            'DESCRIPTORES ONOMÁSTICOS',
            'MATERIAS',
            'NOTAS',
            'NOTAS DE PUBLICACIÓN',
            'NOTAS DEL ARCHIVERO'
        ];
        
        let formHTML = '<div class="sidebar-form">';
        fields.forEach(field => {
            const val = savedData[field] || '';
            const isLong = field.includes('RESUMEN') || field.includes('CARACTERISTICAS') || field.includes('NOTAS') || field.includes('DESCRIPTORES') || field.includes('MATERIAS');
            formHTML += `
                <div class="sidebar-field">
                    <label>${field}</label>
                    ${isLong 
                        ? `<textarea data-field="${field}" readonly placeholder="(Importar archivo para completar)">${escapeHTML(val)}</textarea>`
                        : `<input type="text" data-field="${field}" readonly value="${escapeHTML(val)}" placeholder="(Importar archivo para completar)">`
                    }
                </div>`;
        });
        formHTML += `
            <div class="sidebar-import-zone">
                <input type="file" id="sidebarFileInput" style="display:none" accept=".txt,.json,.xlsx,.xls,.csv,.ods,.docx,.odt">
                <button class="import-sidebar-btn" onclick="document.getElementById('sidebarFileInput').click()">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 14px; height: 14px; margin-right: 8px;">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                        <polyline points="17 8 12 3 7 8"></polyline>
                        <line x1="12" y1="3" x2="12" y2="15"></line>
                    </svg>
                    Importar Ficha (Word/Excel/TXT)
                </button>
                <p class="import-help">Soporta: XLSX, CSV, ODS, DOCX, ODT, TXT</p>
            </div>
        </div>`;

        sidebarBody.innerHTML = `
            <div class="sidebar-section">
                ${imageSrc ? `
                    <div class="sidebar-image-container">
                        <img id="sidebarImagePlaceholder" 
                             src="${imageSrc}" 
                             onclick="window.open(this.src, '_blank')"
                             onerror="if(this.src.includes('.jpg')) this.src=this.src.replace('.jpg','.png'); else this.parentElement.style.display='none';">
                    </div>
                ` : ''}
                <h3>Ficha de Descripción:</h3>
                ${formHTML}
            </div>
        `;
        
        notesSidebar.classList.add('open');
        
        // Handle sidebar file import
        const fileInput = document.getElementById('sidebarFileInput');
        fileInput.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            const btn = document.querySelector('.import-sidebar-btn');
            const originalHTML = btn.innerHTML;
            btn.disabled = true;
            btn.innerHTML = '<span class="spinner-mini"></span> Procesando...';

            try {
                const formData = new FormData();
                formData.append('file', file);

                const parseResp = await fetch('/api/parse-sidebar-file', {
                    method: 'POST',
                    body: formData
                });
                
                if (!parseResp.ok) throw new Error("Error parsing file");
                
                const { data: parsedFields } = await parseResp.json();
                const newData = { ...recordNotes[id], ...parsedFields };

                // Auto-save to server
                const saveResp = await fetch('/api/save-note', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id, note: newData })
                });
                
                if (saveResp.ok) {
                    recordNotes[id] = newData;
                    // Refresh UI
                    openSidebar(id, record);
                    alert("Ficha importada y guardada correctamente.");
                }
            } catch (err) {
                alert("Error al procesar el archivo. Asegúrate de que el formato sea legible.");
                console.error(err);
            } finally {
                btn.disabled = false;
                btn.innerHTML = originalHTML;
                fileInput.value = '';
            }
        };
    };


    window.saveNote = async (id, btn) => {
        const container = btn.parentElement;
        const inputs = container.querySelectorAll('input, textarea');
        const data = {};
        inputs.forEach(input => {
            data[input.dataset.field] = input.value.trim();
        });
        
        btn.disabled = true;
        btn.textContent = 'Guardando...';
        
        try {
            const response = await fetch('/api/save-note', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, note: data }) // Sending the whole object as 'note'
            });
            const resData = await response.json();
            if (resData.success) {
                recordNotes[id] = data;
                btn.textContent = '¡Guardado!';
                btn.classList.add('success');
                setTimeout(() => {
                    btn.textContent = 'Guardar Información';
                    btn.classList.remove('success');
                    btn.disabled = false;
                }, 2000);
            }
        } catch (error) {
            console.error('Error saving note:', error);
            btn.textContent = 'Error';
            btn.disabled = false;
        }
    };

    function setupInfiniteScroll() {
        const old = document.getElementById('loadMoreSentinel');
        if (old) old.remove();
        const sentinel = document.createElement('div');
        sentinel.id = 'loadMoreSentinel';
        sentinel.style.height = '1px';
        resultsContainer.appendChild(sentinel);

        const observer = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting && hasMoreResults && !isLoadingMore) renderNextChunk();
        }, { rootMargin: '400px' });
        observer.observe(sentinel);
    }

    function showNoResults() {
        resultsContainer.innerHTML = `<div class="empty-state"><p>No se encontraron registros.</p></div>`;
    }

    function highlightText(text, query) {
        if (!query) return escapeHTML(text);
        let html = escapeHTML(text);
        
        const accentMap = {
            'a': '[aáàäâ]',
            'e': '[eéèëê]',
            'i': '[iíìïî]',
            'o': '[oóòöô]',
            'u': '[uúùüû]',
            'n': '[nñ]'
        };

        const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
        
        words.forEach(word => {
            // Create a regex that is accent-insensitive
            let pattern = "";
            for (let char of word) {
                pattern += accentMap[char] || char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            }
            try {
                const regex = new RegExp(`(${pattern})`, 'gi');
                html = html.replace(regex, '<mark>$1</mark>');
            } catch(e) {}
        });
        return html;
    }

    function escapeHTML(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    async function initData() {
        try {
            // Fetch notes first
            const nResp = await fetch('/api/notes');
            if (nResp.ok) recordNotes = await nResp.json();

            const resp = await fetch('/api/index-status');
            const status = await resp.json();
            if (status.exists) {
                searchWorker.postMessage({ type: 'LOAD_JSON', payload: { url: '/data_index.json' } });
            } else {
                const fResp = await fetch('/api/files');
                const fData = await fResp.json();
                if (fData.files?.length > 0) {
                    searchWorker.postMessage({ type: 'LOAD_FILES', payload: { files: fData.files, isLocalFiles: false } });
                }
            }
        } catch (e) {
            console.error(e);
        }
    }

    initData();
});
