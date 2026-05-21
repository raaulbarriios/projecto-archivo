const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

const fields = [
    'CODIGO DE REFERENCIA', 'TITULO', 'FECHAS EXTREMAS', 'NIVEL DE DESCRIPCIÓN',
    'VOLUMEN', 'PRODUCTOR', 'RESUMEN', 'CARACTERISTICAS FÍSICAS',
    'DESCRIPTORES TOPOGRÁFICOS', 'DESCRIPTORES ONOMÁSTICOS', 'MATERIAS',
    'NOTAS', 'NOTAS DE PUBLICACIÓN', 'NOTAS DEL ARCHIVERO'
];

function testExcel() {
    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.aoa_to_sheet([
        ['TITULO', 'Este es el titulo'],
        ['RESUMEN', 'Un resumen de la ficha'],
        ['OTRO', 'no importa']
    ]);
    xlsx.utils.book_append_sheet(wb, ws, "Sheet1");
    const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const workbook = xlsx.read(buffer, { type: 'buffer' });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = xlsx.utils.sheet_to_json(firstSheet, { header: 1 });
    const text = rows.map(row => row.join(' ')).join('\n');
    
    console.log("TEXT FROM EXCEL:\n", text);

    const data = {};
    const lines = text.split(/\r?\n/);
    
    lines.forEach(line => {
        const sepIndex = line.indexOf(':');
        if (sepIndex !== -1) {
            const key = line.substring(0, sepIndex).trim().toUpperCase();
            const val = line.substring(sepIndex + 1).trim();
            if (fields.includes(key)) {
                data[key] = val;
            }
        }
    });

    console.log("PARSED DATA (WITH CURRENT LOGIC):", data);
}

testExcel();
