// Empleados y turnos — backend (tabla employees/shifts). Antes: IndexedDB local.
import { api } from '../core/api.js';

export async function list() { return (await api('/api/employees')) || []; }
export async function create(body) { return api('/api/employees', { method: 'POST', body }); }
export async function update(id, body) { return api(`/api/employees/${encodeURIComponent(id)}`, { method: 'PUT', body }); }
export async function remove(id) { return api(`/api/employees/${encodeURIComponent(id)}`, { method: 'DELETE' }); }

export async function listShifts(employeeId, month) {
  const qs = new URLSearchParams();
  if (employeeId) qs.set('employeeId', employeeId);
  if (month) qs.set('month', month);
  return (await api(`/api/shifts?${qs.toString()}`)) || [];
}
// body: { employeeId, date, checkIn?, checkOut?, note? }
export async function saveShift(body) { return api('/api/shifts', { method: 'PUT', body }); }
