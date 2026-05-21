const xlsx = require('xlsx');
const path = require('path');

const filePath = path.join(__dirname, '../data/ahpna/Fondo Fotografico.xlsx');
const workbook = xlsx.readFile(filePath);
const sheetName = workbook.SheetNames[0];
const sheet = workbook.Sheets[sheetName];

const data = xlsx.utils.sheet_to_json(sheet, { header: 1 });
console.log("Primeras 3 filas:");
console.log(data.slice(0, 3));
