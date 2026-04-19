// Helper para exportar a XLSX usando SheetJS (cargado vía CDN en app.html).

export function exportToXLSX({ filename = 'reporte.xlsx', sheets = [] }) {
  if (typeof XLSX === 'undefined') {
    alert('SheetJS no está cargado');
    return;
  }
  const wb = XLSX.utils.book_new();
  for (const sheet of sheets) {
    const ws = XLSX.utils.json_to_sheet(sheet.rows || [], { header: sheet.headers });
    // Auto width
    if (sheet.rows.length > 0) {
      const cols = Object.keys(sheet.rows[0]);
      ws['!cols'] = cols.map(k => ({
        wch: Math.max(k.length, ...sheet.rows.map(r => String(r[k] ?? '').length)) + 2
      }));
    }
    XLSX.utils.book_append_sheet(wb, ws, (sheet.name || 'Hoja1').slice(0, 31));
  }
  XLSX.writeFile(wb, filename);
}

export function exportSimple(filename, rows, sheetName = 'Datos') {
  return exportToXLSX({ filename, sheets: [{ name: sheetName, rows }] });
}
