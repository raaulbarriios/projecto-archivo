const path = require('path');
const xlsx = require('xlsx');

const filePath = path.join(__dirname, '..', 'data', 'ama', 'Sección 1ª_Altas.ods');
console.log("Reading file:", filePath);

try {
    const workbook = xlsx.readFile(filePath);
    const firstSheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[firstSheetName];
    const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: "" });
    
    // Test the new extractDataFromSheet algorithm
    let maxFilled = 0;
    const filledCounts = rows.map(row => {
        const count = row.filter(cell => String(cell).trim() !== "").length;
        if (count > maxFilled) maxFilled = count;
        return count;
    });

    if (maxFilled === 0) {
        console.log("Empty sheet");
        process.exit(0);
    }

    const threshold = Math.min(maxFilled, Math.max(2, Math.floor(maxFilled * 0.25)));
    console.log(`maxFilled: ${maxFilled}, threshold: ${threshold}`);

    let firstDataRow = 0;
    while (firstDataRow < rows.length && filledCounts[firstDataRow] < threshold) {
        firstDataRow++;
    }
    console.log("Detected firstHeaderRow:", firstDataRow);

    let headerEndIndex = firstDataRow;
    let hitEmptyRow = false;
    for (let i = firstDataRow; i < Math.min(firstDataRow + 5, rows.length); i++) {
        const row = rows[i];
        const isEmpty = row.every(cell => String(cell).trim() === "");
        if (isEmpty) {
            headerEndIndex = i - 1;
            hitEmptyRow = true;
            break;
        }
        const hasNumber = row.some(cell => typeof cell === 'number');
        if (hasNumber && i > firstDataRow) {
            headerEndIndex = i - 1;
            break;
        }
    }
    console.log("headerEndIndex:", headerEndIndex);

    if (!hitEmptyRow && headerEndIndex === firstDataRow) {
        const row0 = rows[firstDataRow];
        const row1 = rows[firstDataRow + 1];
        if (row1) {
            let row1FillsGaps = false;
            for (let c = 0; c < row1.length; c++) {
                if (String(row0[c] || "").trim() === "" && String(row1[c] || "").trim() !== "") {
                    row1FillsGaps = true;
                    break;
                }
            }
            if (row1FillsGaps) {
                headerEndIndex = firstDataRow + 1;
                const row2 = rows[firstDataRow + 2];
                if (row2) {
                    let row2FillsGaps = false;
                    for (let c = 0; c < row2.length; c++) {
                        if (String(row1[c] || "").trim() === "" && String(row2[c] || "").trim() !== "") {
                            row2FillsGaps = true;
                            break;
                        }
                    }
                    if (row2FillsGaps) headerEndIndex = firstDataRow + 2;
                }
            }
        }
    }
    console.log("Final headerEndIndex:", headerEndIndex);

    const combinedHeaders = [];
    const maxCols = Math.max(...rows.slice(firstDataRow, headerEndIndex + 1).map(r => r.length));
    
    for (let c = 0; c < maxCols; c++) {
        const parts = [];
        for (let r = firstDataRow; r <= headerEndIndex; r++) {
            const val = String(rows[r][c] || "").trim();
            if (val) parts.push(val);
        }
        let headerName = parts.join(" ");
        if (!headerName) headerName = `__EMPTY_${c}`;
        combinedHeaders.push(headerName);
    }

    console.log("Combined Headers:", combinedHeaders);

    const dataObjects = [];
    let startDataRow = headerEndIndex + 1;
    while (startDataRow < rows.length && rows[startDataRow].every(cell => String(cell).trim() === "")) {
        startDataRow++;
    }

    for (let r = startDataRow; r < rows.length; r++) {
        const row = rows[r];
        if (row.every(cell => String(cell).trim() === "")) continue;
        
        const obj = {};
        for (let c = 0; c < combinedHeaders.length; c++) {
            const val = row[c];
            if (val !== undefined && val !== "") {
                obj[combinedHeaders[c]] = val;
            }
        }
        if (Object.keys(obj).length > 0) {
            dataObjects.push({ _rowNum: r + 1, ...obj });
        }
    }

    console.log("Parsed first 2 data objects:");
    console.log(JSON.stringify(dataObjects.slice(0, 2), null, 2));

} catch (e) {
    console.error("Error reading file:", e.message);
}
