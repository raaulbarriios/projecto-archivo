const xlsx = require('xlsx');
const path = require('path');

const filePath = path.join(__dirname, '../data/ahpna/Fondo Fotografico.xlsx');
const fileBuffer = require('fs').readFileSync(filePath);

const fields = [
    'CODIGO DE REFERENCIA', 'TITULO', 'FECHAS EXTREMAS', 'NIVEL DE DESCRIPCIÓN',
    'VOLUMEN', 'PRODUCTOR', 'RESUMEN', 'CARACTERISTICAS FÍSICAS',
    'DESCRIPTORES TOPOGRÁFICOS', 'DESCRIPTORES ONOMÁSTICOS', 'MATERIAS',
    'NOTAS', 'NOTAS DE PUBLICACIÓN', 'NOTAS DEL ARCHIVERO'
];

function normalizeKey(str) {
    if (!str) return "";
    let n = String(str).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().trim();
    if (n.startsWith("CARACTERISTICAS FISICA")) n = "CARACTERISTICAS FISICAS";
    if (n === "NOTAS DEL ARCHIVO") n = "NOTAS DEL ARCHIVERO";
    return n;
}

const normTargetFields = fields.map(normalizeKey);

let text = "";
const workbook = xlsx.read(fileBuffer, { type: 'buffer' });
const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
const rows = xlsx.utils.sheet_to_json(firstSheet, { header: 1 });

let isHorizontal = false;
if (rows.length >= 2 && rows[0].length > 2) {
    const headerMatches = rows[0].filter(h => h && normTargetFields.includes(normalizeKey(h)));
    if (headerMatches.length >= 2) {
        isHorizontal = true;
    }
}

if (isHorizontal) {
    const headers = rows[0];
    const values = rows[1] || [];
    const linesArr = [];
    for (let i = 0; i < headers.length; i++) {
        if (headers[i] && values[i]) {
            linesArr.push(`${headers[i]}: ${values[i]}`);
        }
    }
    text = linesArr.join('\n');
} else {
    text = rows.map(row => row.join(': ')).join('\n');
}

const data = {};
const lines = text.split(/\r?\n/);

lines.forEach(line => {
    let key = '';
    let val = '';
    const sepIndex = line.indexOf(':');
    
    if (sepIndex !== -1) {
        key = line.substring(0, sepIndex).trim();
        val = line.substring(sepIndex + 1).trim();
    } else {
        const foundField = fields.find(f => line.toUpperCase().startsWith(f));
        if (foundField) {
            key = foundField;
            val = line.substring(foundField.length).trim();
        }
    }
    
    if (!key) return;

    let nKey = normalizeKey(key);
    const index = normTargetFields.indexOf(nKey);
    if (index !== -1) {
        data[fields[index]] = val;
    }
});

console.log("TEXT:\n", text);
console.log("FINAL DATA:", data);
