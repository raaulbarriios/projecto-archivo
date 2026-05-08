document.addEventListener('DOMContentLoaded', () => {
    const searchInput = document.getElementById('searchInput');
    const clearBtn = document.getElementById('clearBtn');
    const resultsContainer = document.getElementById('resultsContainer');
    const resultCount = document.getElementById('resultCount');
    const refreshBtn = document.getElementById('refreshBtn');

    let debounceTimer;
    let searchCache = {}; // Simple caching to reduce API calls for same queries

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

        // Check cache
        if (searchCache[query]) {
            renderResults(searchCache[query], query);
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
            renderResults(results, query);
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

    function renderResults(results, query) {
        resultsContainer.innerHTML = '';

        if (results.length === 0) {
            resultsContainer.innerHTML = `
                <div class="empty-state">
                    <p>No se encontraron registros para "<strong>${escapeHTML(query)}</strong>"</p>
                </div>
            `;
            resultCount.textContent = '0 resultados';
            return;
        }

        resultCount.textContent = `${results.length} coincidencias encontradas`;

        // Delay cards for staggered animation effect
        results.forEach((record, index) => {
            const meta = record.__meta;
            const isSpreadsheet = meta.type === 'spreadsheet';
            
            // Remove meta before iterating main keys
            const displayData = { ...record };
            delete displayData.__meta;

            const card = document.createElement('div');
            card.className = 'record-card';
            card.style.animationDelay = `${index * 0.05}s`;

            // Find matching columns for location info
            let locationInfo = '';
            let hasPhoto = false;

            if (isSpreadsheet && meta.row) {
                const matchingCols = [];
                Object.entries(displayData).forEach(([key, val]) => {
                    const stringVal = String(val).toLowerCase();
                    const stringKey = String(key).toLowerCase();

                    // Detect if this record might have a photo
                    if (stringKey.includes('foto') || stringKey.includes('imagen') || stringVal.includes('http')) {
                        if (val && stringVal !== "" && !stringVal.includes('[error')) {
                            hasPhoto = true;
                        }
                    }

                    if (stringVal.includes(query.toLowerCase())) {
                        // Find the index of this header to get the column letter
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

            // Build html for key-value pairs
            let gridHTML = '<div class="data-grid">';
            
            for (const [key, val] of Object.entries(displayData)) {
                // Skip empty values
                if (val === "" || val === null || val === undefined) continue;

                // Highlight the searched text
                const highlightedValue = highlightText(String(val), query);

                gridHTML += `
                    <div class="data-group">
                        <span class="data-label">${escapeHTML(key)}</span>
                        <span class="data-value">${highlightedValue}</span>
                    </div>
                `;
            }
            gridHTML += '</div>';

            // SVG File icon
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

            resultsContainer.appendChild(card);
        });
    }

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
        let content = escapeHTML(String(text));
        
        // If it looks like a URL, make it clickable
        if (content.startsWith('http')) {
            return `<a href="${content}" target="_blank" class="data-link">Abrir enlace 🔗</a>`;
        }

        if (!query) return content;
        
        // Escape characters for regex
        const safeQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(${safeQuery})`, 'gi');
        
        // Find matches and escape HTML properly
        return content.replace(regex, (match) => `<span class="highlight">${match}</span>`);
    }
});
