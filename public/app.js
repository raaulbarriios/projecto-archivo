// Se ejecuta cuando el contenido del DOM ha sido cargado completamente
document.addEventListener('DOMContentLoaded', () => {
    // Referencias a elementos del DOM (interfaz de usuario)
    const searchInput = document.getElementById('searchInput'); // Campo de búsqueda principal
    const clearBtn = document.getElementById('clearBtn'); // Botón para limpiar la búsqueda
    const resultsContainer = document.getElementById('resultsContainer'); // Contenedor de resultados
    const resultCount = document.getElementById('resultCount'); // Texto que muestra el estado/conteo
    const refreshBtn = document.getElementById('refreshBtn'); // Botón para actualizar datos
    const importBtn = document.getElementById('importBtn'); // Botón para importar archivos
    const fileInput = document.getElementById('fileInput'); // Entrada de archivos (oculta)
    const notesSidebar = document.getElementById('notesSidebar'); // Barra lateral de detalles
    const sidebarBody = document.getElementById('sidebarBody'); // Cuerpo de la barra lateral
    const closeSidebar = document.getElementById('closeSidebar'); // Botón para cerrar la barra lateral
    const sidebarOverlay = document.getElementById('sidebarOverlay'); // Fondo oscuro de la barra lateral
    
    const manageFilesBtn = document.getElementById('manageFilesBtn'); // Botón para abrir gestor de archivos
    const fileManagerSidebar = document.getElementById('fileManagerSidebar'); // Barra lateral de gestor de archivos
    const closeFileManager = document.getElementById('closeFileManager'); // Botón para cerrar gestor de archivos
    const fileManagerOverlay = document.getElementById('fileManagerOverlay'); // Fondo oscuro del gestor de archivos
    const fileManagerBody = document.getElementById('fileManagerBody'); // Cuerpo del gestor de archivos

    // Variables de estado global de la aplicación
    let currentRenderIndex = 0; // Índice actual para el scroll infinito
    const CHUNK_SIZE = 50; // Cantidad de resultados que se cargan por bloque
    let currentQuery = ""; // Almacena la consulta de búsqueda actual
    let isWorkerReady = false; // Indica si el Worker de búsqueda está listo
    let pendingSearch = false; // Indica si hay una búsqueda en cola
    let isLoadingMore = false; // Indica si se están cargando más resultados (scroll)
    let hasMoreResults = true; // Indica si hay más resultados disponibles en el Worker
    let debounceTimer; // Temporizador para evitar búsquedas excesivas mientras se escribe
    let recordNotes = {}; // Almacena las notas/fichas técnicas guardadas en el servidor
    let lastSearchResults = []; // Copia de los últimos resultados para acceso rápido por índice

    // Determinar la sección actual basada en la URL
    const pathName = window.location.pathname.toLowerCase();
    let currentSection = 'ahpna';
    if (pathName.includes('urbanismo')) currentSection = 'urbanismo';
    else if (pathName.includes('ama')) currentSection = 'ama';

    // Lógica de Búsqueda Avanzada
    const advancedSearchToggle = document.getElementById('advancedSearchToggle'); // Botón de toggle
    const advancedPanel = document.getElementById('advancedPanel'); // Panel de filtros extra
    const filterYear = document.getElementById('filterYear'); // Filtro de año
    const filterFile = document.getElementById('filterFile'); // Filtro de archivo original
    const filterDoc = document.getElementById('filterDoc'); // Filtro de observaciones
    const filterNotary = document.getElementById('filterNotary'); // Filtro de Notario

    // Inicialización del Web Worker para realizar búsquedas en segundo plano sin bloquear la UI
    const searchWorker = new Worker('search-worker.js');

    // Evento para mostrar/ocultar el panel de búsqueda avanzada
    advancedSearchToggle.addEventListener('click', () => {
        advancedPanel.classList.toggle('hidden');
        advancedSearchToggle.classList.toggle('active');
    });

    // Añade eventos a los filtros avanzados para disparar la búsqueda al cambiar sus valores
    const filtersToListen = [filterYear, filterFile, filterDoc];
    if (filterNotary) filtersToListen.push(filterNotary);
    
    filtersToListen.forEach(el => {
        if (!el) return;
        const eventType = el.tagName === 'SELECT' ? 'change' : 'input';
        el.addEventListener(eventType, () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                performSearch(searchInput.value.trim());
            }, 300); // Espera 300ms después de que el usuario deje de escribir
        });
    });

    // Evento de escritura en el campo de búsqueda principal
    searchInput.addEventListener('input', (e) => {
        const query = e.target.value.trim();
        clearBtn.classList.toggle('hidden', query.length === 0); // Muestra/oculta el botón X
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => performSearch(query), 300); // Dispara la búsqueda con debounce
    });

    // Evento para limpiar todos los campos de búsqueda y filtros
    clearBtn.addEventListener('click', () => {
        searchInput.value = '';
        filterYear.value = '';
        filterDoc.value = '';
        filterFile.value = '';
        if (filterNotary) filterNotary.value = '';
        clearBtn.classList.add('hidden');
        performSearch(""); // Vuelve al estado inicial
    });
    
    // Eventos para cerrar la barra lateral (haciendo clic en X o en el fondo oscuro)
    [closeSidebar, sidebarOverlay].forEach(el => {
        el.addEventListener('click', () => {
            notesSidebar.classList.remove('open');
        });
    });

    // Evento para recargar los datos desde el servidor
    refreshBtn.addEventListener('click', () => {
        if (refreshBtn.classList.contains('loading')) return;
        refreshBtn.classList.add('loading');
        initData();
    });

    // Función para solicitar al servidor que regenere el índice de búsqueda (JSON optimizado)
    async function triggerRebuild(skipConfirm = false) {
        if (!skipConfirm && !confirm("Esto procesará todos los archivos en el servidor. ¿Continuar?")) return;

        resultCount.textContent = 'Reconstruyendo índice de búsqueda...';
        
        try {
            const response = await fetch(`/api/rebuild-index?section=${currentSection}`, { method: 'POST' });
            const data = await response.json();
            if (data.success) {
                resultCount.textContent = `¡Hecho! ${data.count} registros optimizados.`;
                // Notifica al Worker que cargue el nuevo archivo JSON generado
                searchWorker.postMessage({ type: 'LOAD_JSON', payload: { url: `/data_index_${currentSection}.json` } });
            }
        } catch (err) {
            resultCount.textContent = 'Error al optimizar.';
        }
    }

    // Evento para abrir el selector de archivos al hacer clic en Importar
    importBtn.addEventListener('click', () => fileInput.click());
    
    // Evento que se dispara al seleccionar archivos para subir
    fileInput.addEventListener('change', async (e) => {
        const files = Array.from(e.target.files);
        if (files.length === 0) return;
        
        importBtn.classList.add('loading');
        resultCount.textContent = `Subiendo ${files.length} archivos al servidor...`;

        const formData = new FormData();
        files.forEach(f => formData.append('files', f)); // Prepara los archivos para el envío

        try {
            const response = await fetch(`/api/upload?section=${currentSection}`, {
                method: 'POST',
                body: formData
            });
            const data = await response.json();
            
            if (data.success) {
                resultCount.textContent = `¡Subidos! Procesando e indexando...`;
                // Lanza la reconstrucción del índice automáticamente tras la subida
                triggerRebuild(true);
            } else {
                throw new Error(data.error);
            }
        } catch (err) {
            alert("Error al subir archivos: " + err.message);
            resultCount.textContent = 'Error en la subida.';
        } finally {
            importBtn.classList.remove('loading');
            fileInput.value = ''; // Limpia el input para permitir subir el mismo archivo otra vez
        }
    });

    // Escucha de mensajes provenientes del Web Worker
    searchWorker.onmessage = (e) => {
        const { type, payload, meta } = e.data;
        
        if (type === 'READY') {
            // El Worker ha terminado de cargar los datos
            isWorkerReady = true;
            resultCount.textContent = `Listos. ${payload.totalRecords} registros disponibles.`;
            refreshBtn.classList.remove('loading');
            importBtn.classList.remove('loading');
            if (payload.files) updateFileFilter(payload.files); // Actualiza el selector de archivos
            if (payload.notaries) updateNotaryFilter(payload.notaries); // Actualiza el selector de notarios
            
            // Realiza la búsqueda inicial si hay texto, filtros, o si el usuario intentó buscar antes
            if (pendingSearch || searchInput.value.trim() || filterYear.value.trim() || filterFile.value || filterDoc.value.trim() || (filterNotary && filterNotary.value)) {
                performSearch(searchInput.value.trim()); 
            }
        } else if (type === 'SEARCH_RESULTS') {
            // El Worker devuelve resultados de una búsqueda
            if (meta.offset === 0) {
                // Si es el primer bloque, limpia el contenedor
                resultsContainer.innerHTML = '';
                lastSearchResults = [];
                if (payload.length === 0) showNoResults();
                else resultCount.textContent = `Mostrando resultados para "${currentQuery || 'todo'}"`;
            }
            lastSearchResults.push(...payload); // Guarda resultados para uso posterior
            appendResults(payload, meta.offset); // Añade los resultados al DOM
            isLoadingMore = false;
            hasMoreResults = payload.length === CHUNK_SIZE; // Si vienen menos de 50, ya no hay más
            currentRenderIndex += payload.length;
            setupInfiniteScroll(); // Reinicializa el detector de scroll
        }
    };

    // Actualiza las opciones del desplegable de "Sección / Archivo" basándose en los datos cargados
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

    // Actualiza las opciones del desplegable de "Notario" basándose en los datos cargados
    function updateNotaryFilter(notaries) {
        if (!filterNotary) return;
        const current = filterNotary.value;
        filterNotary.innerHTML = '<option value="">Todos los notarios</option>';
        
        if (notaries && notaries.length > 0) {
            document.getElementById('notaryFilterGroup').style.display = 'flex';
            [...new Set(notaries)].sort().forEach(n => {
                const opt = document.createElement('option');
                opt.value = n;
                opt.textContent = n;
                filterNotary.appendChild(opt);
            });
            filterNotary.value = current;
        } else {
            document.getElementById('notaryFilterGroup').style.display = 'none';
        }
    }

    // Envía una solicitud de búsqueda al Worker
    function performSearch(query) {
        currentQuery = query;
        currentRenderIndex = 0;
        hasMoreResults = true;

        if (!isWorkerReady) {
            pendingSearch = true;
            // Si el usuario borró todo, no marcamos como pendiente real
            if (!query && !filterYear.value.trim() && !filterFile.value && !filterDoc.value.trim() && (!filterNotary || !filterNotary.value)) {
                pendingSearch = false;
                resultsContainer.innerHTML = '';
                const emptyState = document.getElementById('emptyState');
                if (emptyState) {
                    resultsContainer.appendChild(emptyState);
                    emptyState.classList.remove('hidden');
                }
                resultCount.textContent = 'Cargando base de datos...';
                return;
            }

            resultsContainer.innerHTML = '<div class="spinner"></div>';
            resultCount.textContent = 'Preparando índice... La búsqueda comenzará enseguida.';
            return;
        }

        pendingSearch = false;

        // Si no hay nada que buscar y no hay filtros, muestra el estado vacío
        if (!query && !filterYear.value.trim() && !filterFile.value && !filterDoc.value.trim() && (!filterNotary || !filterNotary.value)) {
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

        // Recopila los valores de los filtros avanzados
        const filters = {
            year: filterYear.value.trim(),
            file: filterFile.value,
            doc: filterDoc.value.trim(),
            notary: filterNotary ? filterNotary.value : ""
        };

        // Muestra un spinner de carga
        resultsContainer.innerHTML = '<div class="spinner"></div>';
        // Envía el mensaje al Worker con los parámetros de búsqueda
        searchWorker.postMessage({ 
            type: 'SEARCH', 
            payload: { query, filters, offset: 0, limit: CHUNK_SIZE } 
        });
    }

    // Solicita el siguiente bloque de resultados para el scroll infinito
    function renderNextChunk() {
        if (!isWorkerReady || isLoadingMore || !hasMoreResults) return;
        isLoadingMore = true;
        
        const filters = {
            year: filterYear.value.trim(),
            file: filterFile.value,
            doc: filterDoc.value.trim(),
            notary: filterNotary ? filterNotary.value : ""
        };

        searchWorker.postMessage({ 
            type: 'SEARCH', 
            payload: { query: currentQuery, filters, offset: currentRenderIndex, limit: CHUNK_SIZE } 
        });
    }

    // Inserta los fragmentos de tarjetas de resultados en el contenedor principal
    function appendResults(results, offset) {
        const fragment = document.createDocumentFragment();
        results.forEach((record, i) => {
            fragment.appendChild(createRecordCard(record, offset + i));
        });
        resultsContainer.appendChild(fragment);
    }

    // Lógica para intentar encontrar una imagen asociada a un registro (por nombre, ID o ruta)
    function extractImageSrc(record) {
        if (!record) return null;
        
        // Incluye también los datos de la barra lateral (notas) para buscar la imagen
        const meta = record.__meta;
        const id = meta ? `${meta.file}-${meta.sheet || meta.table}-${meta.row}` : null;
        const notes = id && recordNotes[id] ? recordNotes[id] : {};
        
        const displayData = { ...record, ...notes };
        delete displayData.__meta;

        // Prioridad 1: Busca campos que digan "foto", "imagen" o "ruta" explícitamente
        for (const [key, val] of Object.entries(displayData)) {
            const lowKey = key.toLowerCase();
            if ((lowKey.includes('foto') || lowKey.includes('imagen') || lowKey.includes('ruta')) && val) {
                const cleanVal = String(val).trim();
                return (cleanVal.includes('/') || cleanVal.includes('\\')) 
                    ? `/api/file?path=${encodeURIComponent(cleanVal)}&section=${currentSection}` // Ruta absoluta en el servidor
                    : `/imagenes/${currentSection}/${encodeURIComponent(cleanVal)}`; // Nombre de archivo en carpeta /imagenes
            }
        }
        
        // Prioridad 2: Intenta emparejar campos comunes (ID, Nombre, Pasaporte, Código de Referencia)
        const imgKeys = ['nombre', 'título', 'titulo', 'id', 'pasaporte', 'codigo de referencia', 'código de referencia'];
        for (const [key, val] of Object.entries(displayData)) {
            if (imgKeys.some(k => key.toLowerCase().includes(k)) && val) {
                return `/imagenes/${currentSection}/${encodeURIComponent(String(val).trim())}.jpg`;
            }
        }
        return null;
    }

    // Crea el elemento visual (HTML) de una tarjeta de resultado
    function createRecordCard(record, index) {
        const meta = record?.__meta || { file: 'Desconocido', sheet: '', row: '?' };
        const displayData = { ...record };
        delete displayData.__meta; // Elimina metadatos de la vista de datos brutos

        const card = document.createElement('div');
        card.className = 'record-card';
        
        const imageSrc = extractImageSrc(record); // Intenta obtener la imagen

        let imgHTML = '';
        if (imageSrc) {
            imgHTML = `
                <div class="card-auto-image">
                    <img src="${imageSrc}" 
                         onerror="if(this.src.includes('.jpg')) this.src=this.src.replace('.jpg','.png'); else this.parentElement.style.display='none';"
                         onclick="window.openSidebarByIndex(${index})">
                </div>`;
        }

        // Genera la cuadrícula de datos del registro
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

        // Estructura interna de la tarjeta
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

    // Abre la barra lateral buscando el registro por su índice en la lista de resultados actual
    window.openSidebarByIndex = (index) => {
        const record = lastSearchResults[index];
        if (!record) return;
        const meta = record.__meta;
        const id = `${meta.file}-${meta.sheet || meta.table}-${meta.row}`; // Identificador único del registro
        window.openSidebar(id, record);
    };

    // Construye e inyecta el contenido de la barra lateral (Ficha técnica y Notas)
    window.openSidebar = (id, record) => {
        const savedData = recordNotes[id] || {}; // Recupera notas guardadas si existen
        const imageSrc = extractImageSrc(record);

        // Campos estándar para la ficha de descripción archivística
        const fields = [
            'CODIGO DE REFERENCIA', 'TITULO', 'FECHAS EXTREMAS', 'NIVEL DE DESCRIPCIÓN',
            'VOLUMEN', 'PRODUCTOR', 'RESUMEN', 'CARACTERISTICAS FÍSICAS',
            'DESCRIPTORES TOPOGRÁFICOS', 'DESCRIPTORES ONOMÁSTICOS', 'MATERIAS',
            'NOTAS', 'NOTAS DE PUBLICACIÓN', 'NOTAS DEL ARCHIVERO'
        ];
        
        // Genera el formulario de la ficha (solo lectura por defecto hasta importar datos)
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
        
        // Zona para importar archivos Word/Excel que rellenen la ficha automáticamente
        formHTML += `
            <div class="sidebar-import-zone">
                <input type="file" id="sidebarFileInput" style="display:none" accept=".txt,.json,.xlsx,.xls,.csv,.ods,.odb,.docx,.odt">
                <button class="import-sidebar-btn" onclick="document.getElementById('sidebarFileInput').click()">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 14px; height: 14px; margin-right: 8px;">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                        <polyline points="17 8 12 3 7 8"></polyline>
                        <line x1="12" y1="3" x2="12" y2="15"></line>
                    </svg>
                    Importar Ficha (Word/Excel/TXT)
                </button>
                <p class="import-help">Soporta: XLSX, CSV, ODS, ODB, DOCX, ODT, TXT</p>
            </div>
        </div>`;

        // Inyecta todo en el cuerpo de la barra lateral
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
        
        notesSidebar.classList.add('open'); // Abre la barra lateral
        
        // Manejador para la importación de archivos de ficha específicos del registro
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

                // El servidor procesa el archivo y extrae los campos clave
                const parseResp = await fetch(`/api/parse-sidebar-file?section=${currentSection}`, {
                    method: 'POST',
                    body: formData
                });
                
                if (!parseResp.ok) throw new Error("Error parsing file");
                
                const { data: parsedFields } = await parseResp.json();
                const newData = { ...recordNotes[id], ...parsedFields };

                // Guarda la ficha procesada en la base de datos de notas del servidor
                const saveResp = await fetch(`/api/save-note?section=${currentSection}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id, note: newData })
                });
                
                if (saveResp.ok) {
                    recordNotes[id] = newData;
                    searchWorker.postMessage({ type: 'LOAD_NOTES', payload: recordNotes }); // Actualiza el worker
                    openSidebar(id, record); // Refresca la vista con los nuevos datos
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

    // Guarda manualmente el contenido de los inputs de la barra lateral (si fueran editables)
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
            const response = await fetch(`/api/save-note?section=${currentSection}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id, note: data })
            });
            const resData = await response.json();
            if (resData.success) {
                recordNotes[id] = data;
                searchWorker.postMessage({ type: 'LOAD_NOTES', payload: recordNotes }); // Actualiza el worker
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

    // Lógica del Gestor de Archivos Lateral
    if (manageFilesBtn) {
        manageFilesBtn.addEventListener('click', async () => {
            fileManagerSidebar.classList.add('open');
            await loadFileManagerFiles();
        });
    }

    if (closeFileManager && fileManagerOverlay) {
        [closeFileManager, fileManagerOverlay].forEach(el => {
            el.addEventListener('click', () => {
                fileManagerSidebar.classList.remove('open');
            });
        });
    }

    async function loadFileManagerFiles() {
        if (!fileManagerBody) return;
        fileManagerBody.innerHTML = '<div class="spinner"></div>';
        try {
            const resp = await fetch(`/api/files?section=${currentSection}`);
            const data = await resp.json();
            
            if (!data.files || data.files.length === 0) {
                fileManagerBody.innerHTML = '<div class="empty-state"><p>No hay archivos en esta sección.</p></div>';
                return;
            }

            let html = '<div class="file-manager-list">';
            data.files.forEach(file => {
                html += `
                    <div class="file-manager-item">
                        <div class="file-name" title="${escapeHTML(file)}">${escapeHTML(file)}</div>
                        <div class="file-manager-actions">
                            <button class="action-btn download-btn" title="Descargar" onclick="window.open('/data/${currentSection}/${encodeURIComponent(file)}', '_blank')">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                            </button>
                            <button class="action-btn delete-btn" title="Borrar" onclick="window.deleteFile('${escapeHTML(file).replace(/'/g, "\\'")}')">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
                            </button>
                        </div>
                    </div>
                `;
            });
            html += '</div>';
            fileManagerBody.innerHTML = html;
        } catch (err) {
            fileManagerBody.innerHTML = '<p>Error al cargar archivos.</p>';
            console.error(err);
        }
    }

    // Lógica del modal de confirmación personalizado
    function customConfirm(message, title = 'Confirmar') {
        return new Promise((resolve) => {
            const modal = document.getElementById('confirmModal');
            const titleEl = document.getElementById('confirmModalTitle');
            const messageEl = document.getElementById('confirmModalMessage');
            const acceptBtn = document.getElementById('confirmModalAccept');
            const cancelBtn = document.getElementById('confirmModalCancel');

            if (!modal) {
                resolve(confirm(message));
                return;
            }

            titleEl.textContent = title;
            messageEl.textContent = message;
            modal.classList.add('open');

            const cleanup = () => {
                acceptBtn.removeEventListener('click', onAccept);
                cancelBtn.removeEventListener('click', onCancel);
                modal.classList.remove('open');
            };

            const onAccept = () => { cleanup(); resolve(true); };
            const onCancel = () => { cleanup(); resolve(false); };

            acceptBtn.addEventListener('click', onAccept);
            cancelBtn.addEventListener('click', onCancel);
        });
    }

    window.deleteFile = async (filename) => {
        const isConfirmed = await customConfirm(`¿Estás seguro de que quieres borrar el archivo "${filename}"? Esta acción no se puede deshacer.`, 'Confirmar Borrado');
        if (!isConfirmed) return;

        try {
            const res = await fetch(`/api/files/${encodeURIComponent(filename)}?section=${currentSection}`, {
                method: 'DELETE'
            });
            const data = await res.json();
            if (data.success) {
                await loadFileManagerFiles();
                triggerRebuild(true);
            } else {
                alert("Error al borrar: " + data.error);
            }
        } catch (err) {
            alert("Error de conexión al borrar.");
        }
    };

    // Configura el observador para cargar más resultados cuando el usuario llega al final de la página
    function setupInfiniteScroll() {
        const old = document.getElementById('loadMoreSentinel');
        if (old) old.remove();
        const sentinel = document.createElement('div');
        sentinel.id = 'loadMoreSentinel';
        sentinel.style.height = '1px';
        resultsContainer.appendChild(sentinel);

        const observer = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting && hasMoreResults && !isLoadingMore) renderNextChunk();
        }, { rootMargin: '400px' }); // Dispara la carga 400px antes de llegar al final
        observer.observe(sentinel);
    }

    // Muestra un mensaje informativo cuando no hay coincidencias
    function showNoResults() {
        resultsContainer.innerHTML = `<div class="empty-state"><p>No se encontraron registros.</p></div>`;
    }

    // Resalta en amarillo (<mark>) los términos buscados dentro del texto, ignorando tildes
    function highlightText(text, query) {
        if (!query) return escapeHTML(text);
        let html = escapeHTML(text);
        
        // Mapeo de caracteres para que la búsqueda ignore acentos
        const accentMap = {
            'a': '[aáàäâ]', 'e': '[eéèëê]', 'i': '[iíìïî]',
            'o': '[oóòöô]', 'u': '[uúùüû]', 'n': '[nñ]'
        };

        const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 0);
        
        words.forEach(word => {
            let pattern = "";
            for (let char of word) {
                pattern += accentMap[char] || char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            }
            try {
                const regex = new RegExp(`(${pattern})`, 'gi');
                html = html.replace(regex, '<mark>$1</mark>'); // Envuelve la coincidencia en <mark>
            } catch(e) {}
        });
        return html;
    }

    // Escapa caracteres especiales de HTML para evitar ataques XSS
    function escapeHTML(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // Inicializa los datos de la aplicación al cargar la página
    async function initData() {
        resultCount.textContent = 'Cargando base de datos y preparando búsqueda...';
        refreshBtn.classList.add('loading');
        try {
            // Recupera todas las notas guardadas desde el servidor
            const nResp = await fetch(`/api/notes?section=${currentSection}`);
            if (nResp.ok) {
                recordNotes = await nResp.json();
                searchWorker.postMessage({ type: 'LOAD_NOTES', payload: recordNotes });
            }

            // Verifica si el índice optimizado existe en el servidor
            const resp = await fetch(`/api/index-status?section=${currentSection}`);
            const status = await resp.json();
            if (status.exists) {
                // Carga el JSON gigante de datos indexados
                searchWorker.postMessage({ type: 'LOAD_JSON', payload: { url: `/data_index_${currentSection}.json` } });
            } else {
                // Si no hay índice, intenta cargar los archivos brutos directamente
                const fResp = await fetch(`/api/files?section=${currentSection}`);
                const fData = await fResp.json();
                if (fData.files?.length > 0) {
                    searchWorker.postMessage({ type: 'LOAD_FILES', payload: { files: fData.files, isLocalFiles: false, section: currentSection } });
                }
            }
        } catch (e) {
            console.error(e);
        }
    }

    // Llama a la inicialización al arrancar
    initData();
});
