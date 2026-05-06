document.addEventListener('DOMContentLoaded', () => {
    const searchInput = document.getElementById('searchInput');
    const clearBtn = document.getElementById('clearBtn');
    const resultsContainer = document.getElementById('resultsContainer');
    const resultCount = document.getElementById('resultCount');
    const fileInput = document.getElementById('fileInput');
    const dropZone = document.getElementById('dropZone');
    const uploadLabel = document.getElementById('uploadLabel');

    let debounceTimer;
    let memoryDB = [];
    
    // Files to attempt auto-load (needs a web server, fails on file:///)
    const PREDEFINED_FILES = ['ejemplo.xlsx', 'ejemplo - copia.xlsx'];

    async function loadPredefinedFiles() {
        let loadedCount = 0;
        for (const file of PREDEFINED_FILES) {
            try {
                const response = await fetch(`data/${file}`);
                if (!response.ok) throw new Error('Network response not ok');
                const arrayBuffer = await response.arrayBuffer();
                await processExcelData(arrayBuffer, file);
                loadedCount++;
            } catch (error) {
                console.warn(`No se pudo cargar automáticamente ${file}. Posible bloqueo por CORS en file:/// o archivo no existe.`);
            }
        }
        
        if (loadedCount > 0) {
            resultCount.textContent = `Listos. ${memoryDB.length} registros cargados automáticamente.`;
        } else {
            resultCount.textContent = 'Añade tus Excels para empezar.';
        }
    }

    async function processExcelData(dataBuffer, fileName) {
        // Read with SheetJS
        const workbook = XLSX.read(dataBuffer, { type: 'array' });
        
        workbook.SheetNames.forEach(sheetName => {
            const sheet = workbook.Sheets[sheetName];
            const sheetData = XLSX.utils.sheet_to_json(sheet, { defval: "" });
            
            sheetData.forEach(row => {
                row.__meta = {
                    file: fileName,
                    sheet: sheetName
                };
                memoryDB.push(row);
            });
        });
    }

    // Initialize auto-load
    loadPredefinedFiles();

    // Handle Manual File Upload
    if (fileInput) {
        fileInput.addEventListener('change', async (e) => {
            const files = e.target.files;
            if (files.length > 0) {
                await handleFiles(files);
            }
        });
    }

    // Drag and Drop
    document.body.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (dropZone) dropZone.classList.remove('hidden');
    });

    if (dropZone) {
        dropZone.addEventListener('dragleave', (e) => {
            e.preventDefault();
            dropZone.classList.add('hidden');
        });

        dropZone.addEventListener('drop', async (e) => {
            e.preventDefault();
            dropZone.classList.add('hidden');
            
            const files = e.dataTransfer.files;
            if (files.length > 0) {
                await handleFiles(files);
            }
        });
    }

    async function handleFiles(files) {
        resultCount.textContent = 'Procesando archivos...';
        if (uploadLabel) uploadLabel.style.opacity = '0.5';
        
        let newRecords = 0;
        
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            if (!file.name.endsWith('.xlsx') && !file.name.endsWith('.xls')) continue;
            
            try {
                const arrayBuffer = await file.arrayBuffer();
                const startLength = memoryDB.length;
                await processExcelData(arrayBuffer, file.name);
                newRecords += (memoryDB.length - startLength);
            } catch (error) {
                console.error(`Error procesando ${file.name}:`, error);
            }
        }
        
        if (uploadLabel) uploadLabel.style.opacity = '1';
        resultCount.textContent = `Se añadieron ${newRecords} registros. Total: ${memoryDB.length}`;
        
        // re-run search if needed
        const currentQuery = searchInput.value.trim();
        if (currentQuery) {
            performSearch(currentQuery);
        }
    }

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

    function normalizeString(str) {
        return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    }

    function performSearch(query) {
        if (!query) return;

        resultsContainer.innerHTML = '<div class="spinner"></div>';
        resultCount.textContent = 'Buscando...';

        setTimeout(() => {
            const lowerQuery = normalizeString(query);

            const results = memoryDB.filter(record => {
                return Object.entries(record).some(([key, value]) => {
                    if (key === '__meta') return false;
                    return normalizeString(String(value)).includes(lowerQuery);
                });
            });

            renderResults(results, query);
        }, 50);
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

        // Limit results to prevent DOM freezing on huge result sets
        const displayLimit = 200;
        const resultsToDisplay = results.slice(0, displayLimit);
        
        if (results.length > displayLimit) {
            resultCount.textContent = `Mostrando ${displayLimit} de ${results.length} coincidencias encontradas`;
        }

        resultsToDisplay.forEach((record, index) => {
            const meta = record.__meta;

            const displayData = { ...record };
            delete displayData.__meta;

            const card = document.createElement('div');
            card.className = 'record-card';
            card.style.animationDelay = `${(index % 20) * 0.05}s`;

            let gridHTML = '<div class="data-grid">';

            for (const [key, val] of Object.entries(displayData)) {
                if (val === "" || val === null || val === undefined) continue;

                const highlightedValue = highlightText(String(val), query);

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
                    <span class="card-source" title="Libro: ${escapeHTML(meta.file)}">
                        ${fileIcon} ${escapeHTML(meta.file)} - ${escapeHTML(meta.sheet)}
                    </span>
                </div>
                ${gridHTML}
            `;

            resultsContainer.appendChild(card);
        });
    }

    function showEmptyState() {
        resultsContainer.innerHTML = `
            <div class="empty-state" id="emptyState">
                <div class="empty-icon">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                        <polyline points="14 2 14 8 20 8"></polyline>
                        <line x1="16" y1="13" x2="8" y2="13"></line>
                        <line x1="16" y1="17" x2="8" y2="17"></line>
                        <polyline points="10 9 9 9 8 9"></polyline>
                    </svg>
                </div>
                <p>Las coincidencias se mostrarán aquí.<br>Arrastra archivos Excel o usa el botón para añadirlos manualmente si no cargan solos.</p>
            </div>
        `;
        if (memoryDB.length > 0) {
            resultCount.textContent = `Listos. ${memoryDB.length} registros cargados.`;
        } else {
            resultCount.textContent = 'Añade tus Excels para empezar.';
        }
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
        if (!query) return escapeHTML(text);

        const escapedText = escapeHTML(text);
        const safeQuery = escapeHTML(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        const accentTolerantQuery = safeQuery
            .replace(/a/gi, '[aáAÁ]')
            .replace(/e/gi, '[eéEÉ]')
            .replace(/i/gi, '[iíIÍ]')
            .replace(/o/gi, '[oóOÓ]')
            .replace(/u/gi, '[uúUÚ]');

        const regex = new RegExp(`(${accentTolerantQuery})`, 'gi');

        return escapedText.replace(regex, (match) => `<span class="highlight">${match}</span>`);
    }
});
