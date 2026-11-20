// Módulo Preguntas Mercado Libre: las consultas que hacen los compradores en las
// publicaciones. Se leen en vivo de Mercado Libre y la respuesta se publica ahí mismo, así
// que no hace falta entrar a ML para contestar. Al lado de cada pregunta se ve el producto
// del sistema (precio y stock por sucursal) para responder con el dato real.

import { api, ApiError, getApiBase } from '../core/api.js';
import { isAdmin } from '../core/auth.js';
import { toast } from '../core/notifications.js';

const MAX = 2000; // tope de Mercado Libre para una respuesta

// Todo lo que viene de Mercado Libre (pregunta, título) es texto de terceros: se escapa.
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const money = (n) => '$' + Number(n || 0).toLocaleString('es-AR', { maximumFractionDigits: 0 });

function ago(iso) {
  if (!iso) return '';
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (min < 1) return 'recién';
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  return d === 1 ? 'ayer' : `hace ${d} días`;
}
const fullDate = (iso) => (iso ? new Date(iso).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }) : '');

// Solo se aceptan enlaces/imágenes https de Mercado Libre (el dato viene de afuera).
const safeUrl = (u) => (/^https:\/\/[^\s"'<>]+$/i.test(String(u || '')) ? String(u) : '');

export async function mount(el) {
  const state = { tab: 'UNANSWERED', drafts: new Map(), sending: new Set(), loaded: false };
  el.innerHTML = renderShell();
  const listEl = el.querySelector('#q-list');
  const tabsEl = el.querySelector('#q-tabs');

  function renderTabs(total) {
    const tab = (id, label) => {
      const on = state.tab === id;
      return `<button data-tab="${id}" aria-pressed="${on}" class="px-4 py-2 rounded-full text-sm font-bold border transition-all ${on ? 'bg-[#d82f1e] text-white border-[#d82f1e]' : 'bg-white text-[#241a0d] border-[#e3ceba] hover:border-[#d82f1e]'}">${label}</button>`;
    };
    const n = state.tab === 'UNANSWERED' && typeof total === 'number' && total > 0 ? ` (${total})` : '';
    tabsEl.innerHTML = tab('UNANSWERED', `Sin responder${n}`) + tab('ANSWERED', 'Respondidas');
    tabsEl.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
      if (state.tab === b.dataset.tab) return;
      state.tab = b.dataset.tab; state.loaded = false;
      listEl.innerHTML = '<div class="text-center py-8 text-[#7d6c5c]">Cargando...</div>';
      renderTabs(); refresh();
    }));
  }

  // Guarda lo que se esté escribiendo antes de volver a dibujar (el refresco no lo pisa).
  function keepDrafts() {
    listEl.querySelectorAll('textarea[data-id]').forEach((t) => {
      if (t.value.trim()) state.drafts.set(t.dataset.id, t.value); else state.drafts.delete(t.dataset.id);
    });
  }

  async function refresh() {
    const tab = state.tab;
    // No redibujar mientras alguien escribe: se pierde el foco y la posición del cursor.
    const typing = document.activeElement?.matches?.('textarea[data-id]');
    if (state.loaded && (typing || state.sending.size)) return;
    try {
      const res = await api(`/api/ml-questions?status=${tab}`);
      if (tab !== state.tab) return; // cambió de pestaña mientras cargaba
      keepDrafts();
      state.loaded = true;
      renderTabs(res.total);
      const qs = res.questions || [];
      if (!qs.length) {
        listEl.innerHTML = `
          <div class="text-center py-12 text-[#7d6c5c]">
            <span class="material-symbols-outlined text-5xl">${tab === 'UNANSWERED' ? 'mark_chat_read' : 'forum'}</span>
            <p class="mt-2">${tab === 'UNANSWERED' ? 'No hay preguntas sin responder' : 'Todavía no hay preguntas respondidas'}</p>
          </div>`;
        return;
      }
      const more = res.total > qs.length ? `<p class="text-center text-xs text-[#7d6c5c]">Se muestran las ${qs.length} más nuevas de ${res.total}.</p>` : '';
      listEl.innerHTML = qs.map((q) => renderQuestion(q, state.drafts.get(q.id) || '')).join('') + more;
      bind();
    } catch (err) {
      if (tab !== state.tab) return;
      if (err instanceof ApiError && err.status === 0) {
        listEl.innerHTML = '<div class="text-center py-8 text-red-700">Sin conexión con el servidor</div>';
      } else {
        const d = err.details || {};
        const perm = d.status === 403 || d.status === 401;
        listEl.innerHTML = perm ? `
          <div class="bg-amber-50 border border-amber-200 rounded-2xl p-5 text-sm text-[#241a0d] space-y-2">
            <p class="font-bold text-base">Falta habilitar un permiso en Mercado Libre</p>
            <p>Mercado Libre no deja leer las preguntas porque tu aplicación no tiene activado el permiso <b>Comunicaciones pre y post ventas</b>. Se activa una sola vez:</p>
            <ol class="list-decimal pl-5 space-y-1">
              <li>Entrá a <a href="https://developers.mercadolibre.com.ar/devcenter" target="_blank" rel="noopener noreferrer" class="underline font-bold">Mercado Libre Developers → Mis aplicaciones</a> y abrí tu aplicación para editarla. En la primera pantalla (Información básica) bajá y tocá <b>Continuar</b>.</li>
              <li>En la segunda pantalla, sección <b>Permisos</b>: en <b>Comunicaciones pre y post ventas</b> cambiá <b>Sin acceso</b> por <b>Lectura y escritura</b>.</li>
              <li>Más abajo, en <b>Tópicos</b>, dentro del grupo <b>items</b>, tildá <b>questions</b>. Después guardá los cambios.</li>
              <li>Volvé acá y tocá el botón para autorizar de nuevo la cuenta.</li>
            </ol>
            ${isAdmin() ? '<button id="btn-reauth" class="mt-1 px-4 py-2 bg-[#d82f1e] text-white rounded-xl font-bold text-sm">Volver a autorizar Mercado Libre</button>' : '<p class="text-[#7d6c5c]">Lo tiene que hacer el administrador.</p>'}
          </div>` : `
          <div class="bg-amber-50 border border-amber-200 rounded-2xl p-5 text-sm text-[#241a0d]">
            <p class="font-bold">No se pudieron traer las preguntas de Mercado Libre.</p>
            <p class="mt-1">${esc(d.message || err.message || 'Error desconocido')}</p>
          </div>`;
        // Reautorizar no desvincula nada: solo renueva el permiso de la cuenta ya conectada.
        listEl.querySelector('#btn-reauth')?.addEventListener('click', () => {
          window.location.href = `${getApiBase()}/api/integrations/ml/authorize`;
        });
      }
    }
  }

  function bind() {
    listEl.querySelectorAll('textarea[data-id]').forEach((t) => {
      const counter = listEl.querySelector(`[data-count="${t.dataset.id}"]`);
      const upd = () => {
        const n = t.value.length;
        counter.textContent = `${n} / ${MAX}`;
        counter.classList.toggle('text-red-700', n > MAX);
      };
      t.addEventListener('input', upd); upd();
    });
    listEl.querySelectorAll('.btn-answer').forEach((btn) => btn.addEventListener('click', () => send(btn.dataset.id)));
  }

  async function send(id) {
    const t = listEl.querySelector(`textarea[data-id="${id}"]`);
    const btn = listEl.querySelector(`.btn-answer[data-id="${id}"]`);
    const text = (t?.value || '').trim();
    if (!text) { toast('Escribí la respuesta antes de enviarla', 'warning'); t?.focus(); return; }
    if (text.length > MAX) { toast(`La respuesta es muy larga (máximo ${MAX} caracteres)`, 'warning'); return; }
    if (state.sending.has(id)) return;
    state.sending.add(id);
    btn.disabled = true; btn.textContent = 'Enviando...';
    try {
      await api(`/api/ml-questions/${id}/answer`, { method: 'POST', body: { text } });
      state.drafts.delete(id);
      t.value = '';
      toast('Respuesta publicada en Mercado Libre', 'success');
      state.sending.delete(id);
      t.blur();
      await refresh();
    } catch (err) {
      state.sending.delete(id);
      btn.disabled = false; btn.textContent = 'Responder';
      const d = err.details || {};
      toast(`No se pudo publicar la respuesta: ${d.message || err.message}`, 'error');
    }
  }

  renderTabs();
  await refresh();
  const interval = setInterval(refresh, 60_000);
  return () => clearInterval(interval);
}

function renderProduct(q) {
  const it = q.item, p = q.product;
  const title = it?.title || p?.name || `Publicación ${q.itemId || ''}`;
  const link = safeUrl(it?.permalink);
  const thumb = safeUrl(it?.thumbnail);
  const paused = it?.status && it.status !== 'active' ? `<span class="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-bold">publicación ${it.status === 'paused' ? 'pausada' : esc(it.status)}</span>` : '';
  let stock;
  if (p) {
    const branches = p.stockByBranch.map((b) => `${esc(b.branch)}: <b>${b.qty}</b>`).join(' · ');
    const variants = p.variants.length ? `<div class="mt-0.5">${p.variants.map((v) => `${esc(v.name)}: <b>${v.qty}</b>`).join(' · ')}</div>` : '';
    stock = `<div class="text-xs ${p.stockTotal > 0 ? 'text-[#241a0d]' : 'text-red-700'}">Stock en el sistema: <b>${p.stockTotal}</b> (${branches})${variants}</div>`;
  } else {
    stock = `<div class="text-xs text-[#7d6c5c]">Publicación sin vincular a un producto del sistema${it?.availableQty != null ? ` · stock en Mercado Libre: <b>${it.availableQty}</b>` : ''}</div>`;
  }
  return `
    <div class="flex items-start gap-3">
      ${thumb ? `<img src="${esc(thumb)}" alt="" class="w-14 h-14 rounded-xl object-cover border border-[#fff1e6] bg-white flex-none" loading="lazy" />` : ''}
      <div class="min-w-0 flex-1">
        <p class="font-bold text-sm text-[#241a0d] leading-snug">${link ? `<a href="${esc(link)}" target="_blank" rel="noopener noreferrer" class="hover:underline">${esc(title)}</a>` : esc(title)}</p>
        <p class="text-xs text-[#7d6c5c]">${it?.price != null ? `Precio en Mercado Libre: <b class="text-[#241a0d]">${money(it.price)}</b>` : ''}${p ? `${it?.price != null ? ' · ' : ''}en el sistema: ${money(p.price)}` : ''} ${paused}</p>
        ${stock}
      </div>
    </div>`;
}

function renderQuestion(q, draft) {
  const answered = !!q.answer;
  return `
    <div class="bg-white rounded-2xl shadow-sm border border-[#fff1e6] p-5 space-y-3">
      ${renderProduct(q)}
      <div class="bg-[#fff8f4] rounded-xl p-3">
        <p class="text-[#241a0d] whitespace-pre-wrap break-words">${esc(q.text)}</p>
        <p class="text-xs text-[#7d6c5c] mt-1" title="${esc(fullDate(q.dateCreated))}">Preguntó ${esc(ago(q.dateCreated))} · ${esc(fullDate(q.dateCreated))}</p>
      </div>
      ${answered ? `
        <div class="border-l-4 border-[#d82f1e] pl-3">
          <p class="text-[#241a0d] whitespace-pre-wrap break-words">${esc(q.answer.text)}</p>
          <p class="text-xs text-[#7d6c5c] mt-1">Respondida ${esc(fullDate(q.answer.dateCreated))}</p>
        </div>` : `
        <div class="space-y-2">
          <textarea data-id="${esc(q.id)}" rows="3" maxlength="${MAX}" class="w-full px-3 py-2 rounded-xl border border-[#e3ceba] focus:border-[#d82f1e] outline-none text-sm" placeholder="Escribí la respuesta. Se publica en Mercado Libre y no se puede editar después.">${esc(draft)}</textarea>
          <div class="flex items-center justify-between gap-3">
            <span data-count="${esc(q.id)}" class="text-xs text-[#7d6c5c]">0 / ${MAX}</span>
            <button data-id="${esc(q.id)}" class="btn-answer px-5 py-2 bg-[#d82f1e] text-white rounded-xl font-bold text-sm disabled:opacity-60">Responder</button>
          </div>
        </div>`}
    </div>`;
}

function renderShell() {
  return `
    <div class="max-w-4xl mx-auto space-y-5">
      <header>
        <h1 class="text-3xl font-black text-[#241a0d]">Preguntas Mercado Libre</h1>
        <p class="text-[#7d6c5c] text-sm">Las consultas que hacen los compradores en tus publicaciones. La respuesta se publica en Mercado Libre desde acá.</p>
      </header>
      <div id="q-tabs" class="flex items-center gap-2 flex-wrap"></div>
      <div id="q-list" class="space-y-4">
        <div class="text-center py-8 text-[#7d6c5c]">Cargando...</div>
      </div>
    </div>`;
}
