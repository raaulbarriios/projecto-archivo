const path = require('path');
const xlsx = require('xlsx');

// Este archivo es temporal y simulará la estructura de un archivo, se crea para que el directorio exista
// y no cause errores en la aplicación inicial. Puedes reemplazarlo por archivos reales de Excel.

const dummyData = [
    { Nombre: "Juan Pérez", Documento: "Pasaporte", Fecha: "1789", Observaciones: "Emitido en puerto" }
];

const ws = xlsx.utils.json_to_sheet(dummyData);
const wb = xlsx.utils.book_new();
xlsx.utils.book_append_sheet(wb, ws, "Sheet1");
xlsx.writeFile(wb, path.join(__dirname, 'data', 'ejemplo.xlsx'));
console.log("Archivo de ejemplo creado en /data/ejemplo.xlsx");
