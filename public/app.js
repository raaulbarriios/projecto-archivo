document.addEventListener('DOMContentLoaded', () => {
    const searchInput = document.getElementById('searchInput');
    const clearBtn = document.getElementById('clearBtn');
    const resultsContainer = document.getElementById('resultsContainer');
    const resultCount = document.getElementById('resultCount');
    const refreshBtn = document.getElementById('refreshBtn');
    const rebuildIndexBtn = document.getElementById('rebuildIndexBtn');

    // Pagination and state variables
    let currentRenderIndex = 0;
    const CHUNK_SIZE = 50;
    let currentQuery = "";
    let isWorkerReady = false;
    let isLoadingMore = false;
    let hasMoreResults = true;
    let debounceTimer;

    const searchWorker = new Worker('search-worker.js');

    // Handle user typing
    searchInput.addEventListener('input', (e) => {
        const query = e.target.value.trim();
        
        // Show/hide clear button
        if (query.length > 0) {
            clearBtn.classList.remove('hidden');
        } else {
            clearBtn.classList.add('hidden');
            showEmptyState();
            return;
        }

        // Debounce to avoid hammering the server as they type
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            performSearch(query);
        }, 300);
    });

    // Clear button
    clearBtn.addEventListener('click', () => {
        searchInput.value = '';
        searchInput.focus();
        clearBtn.classList.add('hidden');
        showEmptyState();
    });

    const importBtn = document.getElementById('importBtn');
    const fileInput = document.getElementById('fileInput');

    // Handle messages from worker
    searchWorker.onmessage = (e) => {
        const { type, payload, meta } = e.data;
        
        if (type === 'READY') {
            isWorkerReady = true;
            resultCount.textContent = `Listos. ${payload.totalRecords} registros indexados en base de datos local.`;
            refreshBtn.classList.remove('loading');
            importBtn.classList.remove('loading');
            // Show some initial data
            performSearch("");
        } else if (type === 'SEARCH_RESULTS') {
            const results = payload;
            if (meta.offset === 0) {
                resultsContainer.innerHTML = '';
                if (results.length === 0) {
                    showNoResults();
                } else {
                    resultCount.textContent = `Mostrando resultados para "${currentQuery || 'todo'}"`;
                }
            }
            
            appendResults(results);
            isLoadingMore = false;
            hasMoreResults = results.length === CHUNK_SIZE;
            currentRenderIndex += results.length;
            
            setupInfiniteScroll();
        }
    };

    // Manual Import
    importBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
        const files = Array.from(e.target.files);
        if (files.length === 0) return;
        
        importBtn.classList.add('loading');
        resultCount.textContent = `Procesando e indexando ${files.length} archivos...`;
        searchWorker.postMessage({ type: 'LOAD_FILES', payload: { files, isLocalFiles: true } });
    });

    // Load initial data from server if available
    initData();

    async function initData() {
        resultCount.textContent = 'Verificando índice de datos optimizado...';
        try {
            const statusResp = await fetch('/api/index-status');
            const status = await statusResp.json();
            
            if (status.exists) {
                const sizeMB = (status.size / (1024 * 1024)).toFixed(2);
                resultCount.textContent = `Cargando índice optimizado (${sizeMB} MB)...`;
                searchWorker.postMessage({ type: 'LOAD_JSON', payload: { url: '/data_index.json' } });
                return;
            }

            resultCount.textContent = 'Buscando archivos en el servidor...';
            const response = await fetch('/api/files');
            if (!response.ok) throw new Error();
            const data = await response.json();
            
            if (data.files && data.files.length > 0) {
                resultCount.textContent = `Indexando ${data.files.length} archivos del servidor...`;
                searchWorker.postMessage({ type: 'LOAD_FILES', payload: { files: data.files, isLocalFiles: false } });
            } else {
                checkExistingDB();
            }
        } catch (error) {
            console.log('Servidor no detectado o carpeta vacía, usando base de datos local existente.');
            checkExistingDB();
        }
    }

    async function checkExistingDB() {
        // We can use Dexie here too to check if we have data
        const db = new Dexie("ArchivoDB");
        db.version(2).stores({ records: '++id, file, sheet, row, titulo, autor, isbn, estado, *searchWords' });
        const count = await db.records.count();
        if (count > 0) {
            isWorkerReady = true;
            resultCount.textContent = `Base de datos local cargada: ${count} registros.`;
            performSearch("");
        } else {
            resultCount.textContent = 'No hay datos. Haz clic en "Importar Archivos" para empezar.';
        }
    }

    // Refresh Data button
    refreshBtn.addEventListener('click', () => {
        if (refreshBtn.classList.contains('loading')) return;
        
        refreshBtn.classList.add('loading');
        resultCount.textContent = 'Actualizando archivos...';
        initData();
    });

    // Rebuild Index button
    rebuildIndexBtn.addEventListener('click', async () => {
        if (rebuildIndexBtn.classList.contains('loading')) return;
        
        rebuildIndexBtn.classList.add('loading');
        resultCount.textContent = 'Generando índice JSON en servidor (un momento)...';
        
        try {
            const response = await fetch('/api/rebuild-index', { method: 'POST' });
            const data = await response.json();
            
            if (data.success) {
                resultCount.textContent = `¡Hecho! ${data.count} registros optimizados. Cargando...`;
                searchWorker.postMessage({ type: 'LOAD_JSON', payload: { url: '/data_index.json' } });
            } else {
                throw new Error(data.error);
            }
        } catch (error) {
            console.error(error);
            resultCount.textContent = 'Error al optimizar: ' + error.message;
        } finally {
            rebuildIndexBtn.classList.remove('loading');
        }
    });

    function performSearch(query) {
        if (!query || !isWorkerReady) return;
        currentQuery = query;

        // Check cache
        if (searchCache[query]) {
            allResults = searchCache[query];
            renderInitialResults();
            return;
        }

        // Show loading state
        resultsContainer.innerHTML = '<div class="spinner"></div>';
        resultCount.textContent = 'Buscando en registros locales...';

        // Send search request to worker
        searchWorker.postMessage({ type: 'SEARCH', payload: { query } });
    }

    function performSearch(query) {
        if (!isWorkerReady) return;
        currentQuery = query;
        currentRenderIndex = 0;
        hasMoreResults = true;
        isLoadingMore = true;

        resultsContainer.innerHTML = '<div class="spinner"></div>';
        resultCount.textContent = 'Consultando base de datos...';

        searchWorker.postMessage({ 
            type: 'SEARCH', 
            payload: { query, offset: 0, limit: CHUNK_SIZE } 
        });
    }

    function showNoResults() {
        resultsContainer.innerHTML = `
            <div class="empty-state">
                <p>No se encontraron registros para "<strong>${escapeHTML(currentQuery)}</strong>"</p>
            </div>
        `;
        resultCount.textContent = '0 resultados';
    }

    function appendResults(results) {
        const fragment = document.createDocumentFragment();
        results.forEach((record, i) => {
            const card = createRecordCard(record, currentRenderIndex + i);
            fragment.appendChild(card);
        });
        resultsContainer.appendChild(fragment);
    }

    function renderNextChunk() {
        if (!isWorkerReady || isLoadingMore || !hasMoreResults) return;
        
        isLoadingMore = true;
        searchWorker.postMessage({ 
            type: 'SEARCH', 
            payload: { query: currentQuery, offset: currentRenderIndex, limit: CHUNK_SIZE } 
        });
    }

    function setupInfiniteScroll() {
        // Remove existing sentinel if any
        const oldSentinel = document.getElementById('loadMoreSentinel');
        if (oldSentinel) oldSentinel.remove();

        const sentinel = document.createElement('div');
        sentinel.id = 'loadMoreSentinel';
        sentinel.style.height = '20px';
        sentinel.style.margin = '20px 0';
        resultsContainer.appendChild(sentinel);

        const observer = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting && hasMoreResults && !isLoadingMore) {
                renderNextChunk();
            }
        }, { rootMargin: '400px' });

        observer.observe(sentinel);
    }

    function createRecordCard(record, index) {
        const meta = record.__meta;
        const isSpreadsheet = meta.type === 'spreadsheet';
        
        const displayData = { ...record };
        delete displayData.__meta;

        const card = document.createElement('div');
        card.className = 'record-card';
        // Only animate first few to avoid heavy layout work
        if (index < 20) {
            card.style.animationDelay = `${(index % 20) * 0.05}s`;
        } else {
            card.style.animation = 'none';
            card.style.opacity = '1';
            card.style.transform = 'none';
        }

        let locationInfo = '';
        let hasPhoto = false;

        if (isSpreadsheet && meta.row) {
            const matchingCols = [];
            Object.entries(displayData).forEach(([key, val]) => {
                const stringVal = String(val).toLowerCase();
                const stringKey = String(key).toLowerCase();

                if (stringKey.includes('foto') || stringKey.includes('imagen') || stringVal.includes('http')) {
                    if (val && stringVal !== "" && !stringVal.includes('[error')) {
                        hasPhoto = true;
                    }
                }

                if (stringVal.includes(currentQuery.toLowerCase())) {
                    const colIdx = meta.headers ? meta.headers.indexOf(key) : -1;
                    if (colIdx !== -1) {
                        matchingCols.push(colToLetter(colIdx));
                    }
                }
            });
            
            const sheetLabel = meta.sheet ? `Hoja: ${meta.sheet} - ` : '';
            const photoBadge = hasPhoto ? '<span class="photo-badge" title="Este registro tiene una foto o enlace">📷 FOTO</span>' : '';
            
            locationInfo = `<div class="card-location">📍 ${sheetLabel}Fila: ${meta.row} ${photoBadge}</div>`;
        } else if (meta.row) {
            const typeLabel = meta.table ? `Tabla: ${meta.table} - ` : (meta.sheet ? `Hoja: ${meta.sheet} - ` : '');
            locationInfo = `<div class="card-location">📍 ${typeLabel}Fila: ${meta.row}</div>`;
        }

        let gridHTML = '<div class="data-grid">';
        for (const [key, val] of Object.entries(displayData)) {
            if (val === "" || val === null || val === undefined) continue;
            const highlightedValue = highlightText(String(val), currentQuery);
            gridHTML += `
                <div class="data-group">
                    <span class="data-label">${escapeHTML(key)}</span>
                    <span class="data-value">${highlightedValue}</span>
                </div>
            `;
        }
        gridHTML += '</div>';

        const fileIcon = `
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                <polyline points="14 2 14 8 20 8"></polyline>
                <line x1="16" y1="13" x2="8" y2="13"></line>
                <line x1="16" y1="17" x2="8" y2="17"></line>
                <polyline points="10 9 9 9 8 9"></polyline>
            </svg>
        `;

        card.innerHTML = `
            <div class="card-header">
                <span class="card-source" title="Archivo: ${escapeHTML(meta.file)}">
                    ${fileIcon} ${escapeHTML(meta.file)} - ${escapeHTML(meta.sheet || meta.table)}
                </span>
                ${locationInfo}
            </div>
            ${gridHTML}
        `;

        return card;
    }

    // Keep original renderResults but it's now mostly unused or can be removed
    // I'll keep the utilities below...

    function showEmptyState() {
        resultsContainer.innerHTML = `
            <div class="empty-state" id="emptyState">
                <p>Las coincidencias se mostrarán aquí. El sistema buscará en todo el contenido de los Excel vinculados.</p>
            </div>
        `;
        resultCount.textContent = 'Escriba para empezar a buscar.';
    }

    // Utilities
    function colToLetter(col) {
        let letter = "";
        while (col >= 0) {
            letter = String.fromCharCode((col % 26) + 65) + letter;
            col = Math.floor(col / 26) - 1;
        }
        return letter;
    }

    function escapeHTML(str) {
        return str.replace(/[&<>'"]/g, 
            tag => ({
                '&': '&amp;',
                '<': '&lt;',
                '>': '&gt;',
                "'": '&#39;',
                '"': '&quot;'
            }[tag] || tag)
        );
    }

    function highlightText(text, query) {
        if (!text) return "";
        let content = String(text).trim();
        
        // Check if it's a URL
        const urlRegex = /(https?:\/\/[^\s]+)/g;
        if (urlRegex.test(content) && content.length < 500) {
             // If it's JUST a URL, return a nice button
             if (content.match(/^https?:\/\/[^\s]+$/)) {
                 return `<a href="${content}" target="_blank" class="data-link">Abrir enlace 🔗</a>`;
             }
             // If it contains a URL, replace it with a link
             content = content.replace(urlRegex, (url) => `<a href="${url}" target="_blank" class="text-link">${url}</a>`);
        }

        // Detect if it's a file path (and not a long text)
        if (isFilePath(content) && content.length < 300) {
            return renderPathThumbnail(content, query);
        }

        let escapedContent = content.includes('<a') ? content : escapeHTML(content);
        if (!query) return escapedContent;
        
        // Escape characters for regex
        const safeQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(${safeQuery})`, 'gi');
        
        // Find matches and escape HTML properly, but avoid breaking existing links if we injected them
        if (content.includes('<a')) {
            // Complex case: highlight only outside tags
            return escapedContent; // For now skip highlighting in complex HTML to avoid breakage
        }

        return escapedContent.replace(regex, (match) => `<span class="highlight">${match}</span>`);
    }


    function isFilePath(str) {
        if (typeof str !== 'string' || str.length < 3) return false;
        if (str.startsWith('http')) return false;

        // Basic path detection: starts with C:\, C:/, //, /, ./, or ../
        const pathRegex = /^([a-zA-Z]:[\\/]|\\\\|\/|\.\/|\.\.\\)/;

        const extensionRegex = /\.(jpg|jpeg|png|gif|webp|pdf|docx|xlsx|xls|txt|csv|ods|accdb|mdb|zip|rar|mp4|mov|pptx|html)$/i;
        
        // Also check if it's just a filename with an image extension (often found in excel columns)
        const isJustImageFile = extensionRegex.test(str) && !str.includes(' ') && str.length < 50;

        return pathRegex.test(str) || (extensionRegex.test(str) && (str.includes('\\') || str.includes('/'))) || isJustImageFile;
    }


    function renderPathThumbnail(pathStr, query) {
        const fileName = pathStr.split(/[\\/]/).pop();
        const extension = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '';
        const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(extension);
        
        // Determine the best source for the image
        let imgSrc = null;
        if (isImage) {
            if (pathStr.includes('\\') || pathStr.includes('/') || pathStr.includes(':')) {
                // It's a path, use the file proxy
                imgSrc = `/api/file?path=${encodeURIComponent(pathStr)}`;
            } else {
                // It's just a filename, look in the /imagenes folder
                imgSrc = `/imagenes/${encodeURIComponent(pathStr)}`;
            }
        }
        
        const previewUrl = isImage ? imgSrc : `/api/file?path=${encodeURIComponent(pathStr)}`;
        const openUrl = `/api/open-file?path=${encodeURIComponent(pathStr)}`;
        
        const fileIcon = `
            <svg class="file-icon-placeholder" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path>
                <polyline points="13 2 13 9 20 9"></polyline>
            </svg>
        `;

        return `
            <div class="path-thumbnail-container" onclick="if(event.target.tagName !== 'BUTTON' && event.target.tagName !== 'A') window.open('${previewUrl}', '_blank')">
                <div class="thumbnail-wrapper" title="Hacer clic para previsualizar">
                    ${isImage ? `
                        <img src="${imgSrc}" 
                             alt="${escapeHTML(fileName)}" 
                             class="thumbnail-img" 
                             onload="this.classList.add('loaded')"
                             onerror="this.style.display='none'; this.nextElementSibling.style.display='block'">
                        <div style="display:none">${fileIcon}</div>
                    ` : fileIcon}
                </div>
                <div class="file-info">
                    <span class="file-name" title="Hacer clic para previsualizar">${highlightTextRaw(fileName, query)}</span>
                    <span class="file-type">${extension || 'archivo'}</span>
                    <div class="path-actions">
                        <a href="${previewUrl}" target="_blank" class="path-link">Previsualizar</a>
                        <button onclick="openLocally(event, '${pathStr}')" class="path-button" title="Abrir con el programa del sistema">Abrir en PC 💻</button>
                    </div>
                </div>
            </div>
        `;
    }

    // New helper for opening local files with feedback
    window.openLocally = async (event, path) => {
        event.stopPropagation();
        const btn = event.currentTarget;
        const originalText = btn.innerHTML;
        
        try {
            btn.innerHTML = 'Abriendo...';
            btn.style.opacity = '0.7';
            const response = await fetch(`/api/open-file?path=${encodeURIComponent(path)}`);
            if (!response.ok) throw new Error();
            
            btn.innerHTML = '¡Abierto! ✅';
            setTimeout(() => {
                btn.innerHTML = originalText;
                btn.style.opacity = '1';
            }, 2000);
        } catch (e) {
            btn.innerHTML = 'Error ❌';
            setTimeout(() => {
                btn.innerHTML = originalText;
                btn.style.opacity = '1';
            }, 2000);
        }
    };



    function highlightTextRaw(text, query) {
        if (!text) return "";
        let escaped = escapeHTML(String(text));
        if (!query) return escaped;
        const safeQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(${safeQuery})`, 'gi');
        return escaped.replace(regex, (match) => `<span class="highlight">${match}</span>`);
    }
});
