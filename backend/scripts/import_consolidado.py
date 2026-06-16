# Importa el consolidado (Inventario_Consolidado.xlsx) al backend vía POST /api/products/bulk.
# Idempotente: el endpoint saltea por `code` existente. Corre en chunks.
import json, urllib.request, pandas as pd

BASE = 'https://ingenium-jugueteria-production-0632.up.railway.app'
XLSX = r'C:\Users\Usuario\Desktop\Inventario_Consolidado.xlsx'
CHUNK = 500

def post(path, body, token=None):
    data = json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, method='POST',
                                 headers={'Content-Type': 'application/json', **({'Authorization': 'Bearer ' + token} if token else {})})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode())

def num(x):
    try:
        f = float(str(x).strip().replace(',', '')); return f
    except: return 0.0
def i(x):
    try: return int(float(str(x).strip().replace(',', '')))
    except: return 0

tok = post('/auth/login-pin', {'branchId': 'br_lomas', 'userId': 'u_lomas', 'pin': '1111'})['token']
df = pd.read_excel(XLSX, dtype=str).fillna('')
items = []
for _, r in df.iterrows():
    code = str(r['CODIGO']).strip()
    if not code: continue
    items.append({
        'code': code, 'name': str(r['DESCRIPCION']).strip() or code,
        'cost': num(r['COSTO']), 'price': num(r['PRECIO']),
        'stocks': {'br_lomas': i(r.get('STOCK_LOMAS', 0)), 'br_banfield': i(r.get('STOCK_BANFIELD', 0))},
    })
print('items a importar:', len(items))
tot_c = tot_s = 0
for k in range(0, len(items), CHUNK):
    chunk = items[k:k + CHUNK]
    res = post('/api/products/bulk', chunk, tok)
    tot_c += res.get('creados', res.get('created', 0)); tot_s += res.get('salteados', res.get('skipped', 0))
    print(f'  chunk {k // CHUNK + 1}: creados={res.get("created")} salteados={res.get("skipped")} (acum creados={tot_c}, salteados={tot_s})')
print('LISTO. creados total:', tot_c, '| salteados total:', tot_s)
