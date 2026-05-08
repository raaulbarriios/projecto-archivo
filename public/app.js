document.addEventListener('DOMContentLoaded', () => {
    const searchInput = document.getElementById('searchInput');
    const clearBtn = document.getElementById('clearBtn');
    const resultsContainer = document.getElementById('resultsContainer');
    const resultCount = document.getElementById('resultCount');
    const refreshBtn = document.getElementById('refreshBtn');

    let debounceTimer;
    let searchCache = {}; // Simple caching to reduce API calls for same queries
    
    // Pagination variables
    let allResults = [];
    let currentRenderIndex = 0;
    const CHUNK_SIZE = 50;
    let currentQuery = "";

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

    // Refresh Data button
    refreshBtn.addEventListener('click', async () => {
        const originalText = refreshBtn.innerHTML;
        refreshBtn.innerHTML = 'Actualizando...';
        refreshBtn.style.opacity = '0.5';
        refreshBtn.style.pointerEvents = 'none';

        try {
            const response = await fetch('/api/refresh');
            const data = await response.json();
            
            // Re-run current search if exists
            const currentQuery = searchInput.value.trim();
            searchCache = {}; // Invalidate cache
            
            if (currentQuery) {
                performSearch(currentQuery);
            } else {
                resultCount.textContent = `Listos. ${data.totalRecords} registros en memoria.`;
            }
        } catch (error) {
            console.error("Error refreshing data:", error);
            resultCount.textContent = "Error al actualizar caché.";
        } finally {
            refreshBtn.innerHTML = originalText;
            refreshBtn.style.opacity = '1';
            refreshBtn.style.pointerEvents = 'auto';
        }
    });

    async function performSearch(query) {
        if (!query) return;
        currentQuery = query;

        // Check cache
        if (searchCache[query]) {
            allResults = searchCache[query];
            renderInitialResults();
            return;
        }

        // Show loading state
        resultsContainer.innerHTML = '<div class="spinner"></div>';
        resultCount.textContent = 'Buscando...';

        try {
            const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
            if (!response.ok) throw new Error('Network response was not ok');
            
            const results = await response.json();
            searchCache[query] = results; // Save to cache
            allResults = results;
            renderInitialResults();
        } catch (error) {
            console.error('Error fetching search results:', error);
            resultsContainer.innerHTML = `
                <div class="empty-state" style="border-color: #ff4b4b;">
                    <p style="color: #ff4b4b;">Error de conexión con el servidor local. Asegúrate de ejecutar <code>node server.js</code></p>
                </div>
            `;
            resultCount.textContent = '';
        }
    }

    function renderInitialResults() {
        resultsContainer.innerHTML = '';
        currentRenderIndex = 0;
        
        if (allResults.length === 0) {
            resultsContainer.innerHTML = `
                <div class="empty-state">
                    <p>No se encontraron registros para "<strong>${escapeHTML(currentQuery)}</strong>"</p>
                </div>
            `;
            resultCount.textContent = '0 resultados';
            return;
        }

        resultCount.textContent = `${allResults.length} coincidencias encontradas`;
        renderNextChunk();
        
        // Add sentinel for infinite scroll
        setupInfiniteScroll();
    }

    function renderNextChunk() {
        const nextIndex = Math.min(currentRenderIndex + CHUNK_SIZE, allResults.length);
        const chunk = allResults.slice(currentRenderIndex, nextIndex);
        
        const fragment = document.createDocumentFragment();
        
        chunk.forEach((record, i) => {
            const card = createRecordCard(record, currentRenderIndex + i);
            fragment.appendChild(card);
        });
        
        resultsContainer.appendChild(fragment);
        currentRenderIndex = nextIndex;

        // Hide sentinel if all loaded
        const sentinel = document.getElementById('loadMoreSentinel');
        if (currentRenderIndex >= allResults.length && sentinel) {
            sentinel.style.display = 'none';
        } else if (sentinel) {
            sentinel.style.display = 'block';
        }
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
            if (entries[0].isIntersecting && currentRenderIndex < allResults.length) {
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
                    const colIdx = meta.headers.indexOf(key);
                    if (colIdx !== -1) {
                        matchingCols.push(colToLetter(colIdx));
                    }
                }
            });
            
            const colLabel = matchingCols.length > 0 ? ` - Col: ${matchingCols.join(', ')}` : '';
            const sheetLabel = meta.sheet ? `Hoja: ${meta.sheet} - ` : '';
            const photoBadge = hasPhoto ? '<span class="photo-badge" title="Este registro tiene una foto o enlace">📷 FOTO</span>' : '';
            
            locationInfo = `<div class="card-location">📍 ${sheetLabel}Fila: ${meta.row}${colLabel} ${photoBadge}</div>`;
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
        let content = String(text);
        
        // Detect if it's a file path
        if (isFilePath(content)) {
            return renderPathThumbnail(content, query);
        }

        // If it looks like a URL, make it clickable
        if (content.startsWith('http')) {
            return `<a href="${content}" target="_blank" class="data-link">Abrir enlace 🔗</a>`;
        }

        let escapedContent = escapeHTML(content);
        if (!query) return escapedContent;
        
        // Escape characters for regex
        const safeQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(${safeQuery})`, 'gi');
        
        // Find matches and escape HTML properly
        return escapedContent.replace(regex, (match) => `<span class="highlight">${match}</span>`);
    }

    function isFilePath(str) {
        if (typeof str !== 'string' || str.length < 3) return false;
        // Basic path detection: starts with C:\, /, ./, or contains \ and has an extension
        const pathRegex = /^([a-zA-Z]:\\|\\\\|\/|\.\/|\.\.\\)/;
        const extensionRegex = /\.(jpg|jpeg|png|gif|webp|pdf|docx|xlsx|xls|txt|csv|ods|accdb|mdb|zip|rar|mp4|mov)$/i;
        
        // Return true if it looks like a path or if it has a file extension and common path separators
        return pathRegex.test(str) || (extensionRegex.test(str) && (str.includes('\\') || str.includes('/')));
    }

    function renderPathThumbnail(pathStr, query) {
        const fileName = pathStr.split(/[\\/]/).pop();
        const extension = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '';
        const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(extension);
        
        // Encode path for the API
        const imgSrc = isImage ? `/api/file?path=${encodeURIComponent(pathStr)}` : null;
        
        const fileIcon = `
            <svg class="file-icon-placeholder" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path>
                <polyline points="13 2 13 9 20 9"></polyline>
            </svg>
        `;

        return `
            <div class="path-thumbnail-container">
                <div class="thumbnail-wrapper">
                    ${isImage ? `<img src="${imgSrc}" alt="${escapeHTML(fileName)}" class="thumbnail-img" onerror="this.style.display='none'; this.nextElementSibling.style.display='block'"><div style="display:none">${fileIcon}</div>` : fileIcon}
                </div>
                <div class="file-info">
                    <span class="file-name" title="${escapeHTML(pathStr)}">${highlightTextRaw(fileName, query)}</span>
                    <span class="file-type">${extension || 'archivo'}</span>
                    <a href="/api/file?path=${encodeURIComponent(pathStr)}" target="_blank" class="path-link" title="Abrir archivo">Abrir en nueva pestaña</a>
                </div>
            </div>
        `;
    }

    function highlightTextRaw(text, query) {
        if (!text) return "";
        let escaped = escapeHTML(String(text));
        if (!query) return escaped;
        const safeQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(${safeQuery})`, 'gi');
        return escaped.replace(regex, (match) => `<span class="highlight">${match}</span>`);
    }
});
