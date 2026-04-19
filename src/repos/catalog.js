// CRUD para categorías, marcas, proveedores, subcategorías.
import { put, del, getAll, newId, get } from '../core/db.js';
import * as Audit from '../core/audit.js';

const mk = (store, entityLabel) => ({
  list: () => getAll(store),
  get:  (id) => get(store, id),
  async save(data) {
    const isNew = !data.id;
    const before = isNew ? null : await get(store, data.id);
    const rec = { ...data, id: data.id || newId(entityLabel.slice(0,3)) };
    await put(store, rec);
    await Audit.log({
      action: isNew ? 'create' : 'update',
      entity: entityLabel, entity_id: rec.id,
      before, after: rec,
      description: `${isNew ? 'Creó' : 'Actualizó'} ${entityLabel} "${rec.name}"`,
    });
    return rec;
  },
  async remove(id) {
    const before = await get(store, id);
    await del(store, id);
    await Audit.log({
      action: 'delete', entity: entityLabel, entity_id: id,
      before, description: `Eliminó ${entityLabel} "${before?.name || id}"`,
    });
  },
});

export const Categories    = mk('categories',    'categoria');
export const Subcategories = mk('subcategories', 'subcategoria');
export const Brands        = mk('brands',        'marca');
export const Suppliers     = mk('suppliers',     'proveedor');
