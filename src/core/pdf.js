// Impresión simple: abre una ventana con el HTML listo para imprimir.
// Para vales, remitos y comprobantes internos (sin jsPDF, usa window.print).

export function printHTML({ title = 'Ingenium', bodyHTML = '' }) {
  const w = window.open('', '_blank', 'width=780,height=900');
  if (!w) { alert('Tu navegador bloqueó la ventana. Permití popups para imprimir.'); return; }
  w.document.write(`<!DOCTYPE html>
<html><head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <style>
    body { font-family: 'Plus Jakarta Sans', Arial, sans-serif; color: #241a0d; padding: 32px; max-width: 720px; margin: 0 auto; }
    .brand { color: #d82f1e; font-weight: 900; font-size: 28px; letter-spacing: -0.03em; }
    h1 { color: #d82f1e; margin: 0; }
    h2 { border-bottom: 2px solid #d82f1e; padding-bottom: 8px; }
    table { width: 100%; border-collapse: collapse; margin: 16px 0; }
    th, td { border-bottom: 1px solid #e3ceba; padding: 8px; text-align: left; }
    th { background: #fff1e6; font-size: 11px; text-transform: uppercase; letter-spacing: .1em; }
    .total { text-align: right; font-size: 20px; font-weight: 900; margin-top: 20px; color: #d82f1e; }
    .muted { color: #7d6c5c; font-size: 12px; }
    .stamp { border: 2px dashed #d82f1e; padding: 16px; text-align: center; border-radius: 12px; margin: 20px 0; }
    @media print { .no-print { display: none; } body { padding: 0; } }
  </style>
</head>
<body>
  <div class="no-print" style="text-align:right;margin-bottom:20px">
    <button onclick="window.print()" style="padding:8px 16px;background:#d82f1e;color:white;border:none;border-radius:999px;font-weight:bold;cursor:pointer">Imprimir</button>
    <button onclick="window.close()" style="padding:8px 16px;margin-left:8px;background:#f5dfca;border:none;border-radius:999px;cursor:pointer">Cerrar</button>
  </div>
  ${bodyHTML}
</body></html>`);
  w.document.close();
}
