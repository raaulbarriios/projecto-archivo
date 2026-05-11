document.addEventListener('DOMContentLoaded', () => {
    const searchInput = document.getElementById('searchInput');
    const clearBtn = document.getElementById('clearBtn');
    const resultsContainer = document.getElementById('resultsContainer');
    const resultCount = document.getElementById('resultCount');
    const refreshBtn = document.getElementById('refreshBtn');
    const rebuildIndexBtn = document.getElementById('rebuildIndexBtn');
    const importBtn = document.getElementById('importBtn');
    const fileInput = document.getElementById('fileInput');

    // State variables
    let currentRenderIndex = 0;
    const CHUNK_SIZE = 50;
    let currentQuery = "";
    let isWorkerReady = false;
    let isLoadingMore = false;
    let hasMoreResults = true;
    let debounceTimer;

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
                if (payload.length === 0) showNoResults();
                else resultCount.textContent = `Mostrando resultados para "${currentQuery || 'todo'}"`;
            }
            appendResults(payload);
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

    function appendResults(results) {
        const fragment = document.createDocumentFragment();
        results.forEach((record, i) => {
            fragment.appendChild(createRecordCard(record, currentRenderIndex + i));
        });
        resultsContainer.appendChild(fragment);
    }

    function createRecordCard(record, index) {
        const meta = record.__meta;
        const displayData = { ...record };
        delete displayData.__meta;

        const card = document.createElement('div');
        card.className = 'record-card';
        
        // Image logic
        let imageSrc = null;
        for (const [key, val] of Object.entries(displayData)) {
            const lowKey = key.toLowerCase();
            if ((lowKey.includes('foto') || lowKey.includes('imagen') || lowKey.includes('ruta')) && val) {
                const cleanVal = String(val).trim();
                imageSrc = (cleanVal.includes('/') || cleanVal.includes('\\')) 
                    ? `/api/file?path=${encodeURIComponent(cleanVal)}`
                    : `/imagenes/${encodeURIComponent(cleanVal)}`;
                break;
            }
        }
        if (!imageSrc) {
            const imgKeys = ['nombre', 'título', 'titulo', 'id', 'pasaporte'];
            for (const [key, val] of Object.entries(displayData)) {
                if (imgKeys.some(k => key.toLowerCase().includes(k)) && val) {
                    imageSrc = `/imagenes/${encodeURIComponent(String(val).trim())}.jpg`;
                    break;
                }
            }
        }

        let imgHTML = '';
        if (imageSrc) {
            imgHTML = `
                <div class="card-auto-image">
                    <img src="${imageSrc}" 
                         onerror="if(this.src.includes('.jpg')) this.src=this.src.replace('.jpg','.png'); else this.parentElement.style.display='none';"
                         onclick="window.open(this.src, '_blank')">
                </div>`;
        }

        let gridHTML = '<div class="data-grid">';
        for (const [key, val] of Object.entries(displayData)) {
            if (!val) continue;
            gridHTML += `
                <div class="data-group">
                    <span class="data-label">${escapeHTML(key)}</span>
                    <span class="data-value">${highlightText(String(val), currentQuery)}</span>
                </div>`;
        }
        gridHTML += '</div>';

        card.innerHTML = `
            <div class="card-content-wrapper">
                ${imgHTML}
                <div class="card-main-info">
                    <div class="card-header">
                        <span class="card-source">📄 ${escapeHTML(meta.file)} - ${escapeHTML(meta.sheet || meta.table)}</span>
                        <div class="card-location">📍 Fila: ${meta.row}</div>
                    </div>
                    ${gridHTML}
                </div>
            </div>`;
        return card;
    }

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
        const words = query.split(/\s+/).filter(w => w.length > 2);
        let html = escapeHTML(text);
        words.forEach(word => {
            const regex = new RegExp(`(${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
            html = html.replace(regex, '<mark>$1</mark>');
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
