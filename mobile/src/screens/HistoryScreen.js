import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, RefreshControl, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { getBranches, getSeries } from '../api';
import { COLORS } from '../config';

const money = (n) => '$' + Number(n || 0).toLocaleString('es-AR');
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];

const dayLabel = (s) => {
  // s = 'YYYY-MM-DD'
  const [y, m, d] = s.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return { main: `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`, sub: DIAS[dow] };
};
const monthLabel = (s) => {
  const [y, m] = s.split('-').map(Number);
  return { main: MESES[m - 1], sub: String(y) };
};

export default function HistoryScreen({ session, onBack }) {
  const isAdmin = session.user?.role === 'admin';
  const [branches, setBranches] = useState([]);
  const [scope, setScope] = useState(''); // '' = las dos (admin) o su sucursal (no-admin forzado por el back)
  const [tab, setTab] = useState('days'); // 'days' | 'months'
  const [data, setData] = useState({ daily: [], monthly: [] });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (isAdmin) getBranches().then(setBranches).catch(() => setBranches([]));
  }, [isAdmin]);

  const load = useCallback(async () => {
    try {
      setErr('');
      const d = await getSeries(session.token, scope || undefined);
      setData(d || { daily: [], monthly: [] });
    } catch {
      setErr('No se pudo cargar el historial');
    } finally {
      setLoading(false);
    }
  }, [session, scope]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const rowsRaw = tab === 'days' ? data.daily : data.monthly;
  const rows = [...rowsRaw].reverse(); // más reciente arriba
  const max = Math.max(1, ...rows.map((r) => r.total));
  const periodTotal = rows.reduce((n, r) => n + (r.total || 0), 0);
  const periodCount = rows.reduce((n, r) => n + (r.count || 0), 0);

  const chips = isAdmin
    ? [{ id: '', name: 'Las dos' }, ...branches.map((b) => ({ id: b.id, name: b.name }))]
    : [];

  return (
    <ScrollView
      style={{ backgroundColor: COLORS.bg }}
      contentContainerStyle={s.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.red} />}
    >
      <TouchableOpacity onPress={onBack} style={s.backBtn}><Text style={s.back}>‹ Volver al panel</Text></TouchableOpacity>
      <Text style={s.title}>Historial</Text>

      {chips.length > 0 && (
        <View style={s.chips}>
          {chips.map((c) => (
            <TouchableOpacity key={c.id || 'all'} onPress={() => setScope(c.id)} style={[s.chip, scope === c.id && s.chipOn]}>
              <Text style={[s.chipTxt, scope === c.id && s.chipTxtOn]}>{c.name}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      <View style={s.tabs}>
        <TouchableOpacity onPress={() => setTab('days')} style={[s.tab, tab === 'days' && s.tabOn]}>
          <Text style={[s.tabTxt, tab === 'days' && s.tabTxtOn]}>Por día (30)</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setTab('months')} style={[s.tab, tab === 'months' && s.tabOn]}>
          <Text style={[s.tabTxt, tab === 'months' && s.tabTxtOn]}>Por mes (12)</Text>
        </TouchableOpacity>
      </View>

      <View style={s.summary}>
        <Text style={s.sumLbl}>{tab === 'days' ? 'Últimos 30 días' : 'Últimos 12 meses'}</Text>
        <Text style={s.sumVal}>{money(periodTotal)}</Text>
        <Text style={s.sumSub}>{periodCount} venta{periodCount === 1 ? '' : 's'}</Text>
      </View>

      {err ? <Text style={s.err}>{err}</Text> : null}
      {loading ? (
        <ActivityIndicator size="large" color={COLORS.red} style={{ marginTop: 30 }} />
      ) : (
        rows.map((r) => {
          const lbl = tab === 'days' ? dayLabel(r.day) : monthLabel(r.month);
          const pct = Math.round((r.total / max) * 100);
          return (
            <View key={r.day || r.month} style={s.row}>
              <View style={s.rowLbl}>
                <Text style={s.rowMain}>{lbl.main}</Text>
                <Text style={s.rowSub}>{lbl.sub}</Text>
              </View>
              <View style={s.barWrap}>
                <View style={[s.bar, { width: `${Math.max(pct, r.total > 0 ? 3 : 0)}%` }]} />
              </View>
              <View style={s.rowAmt}>
                <Text style={s.amt}>{money(r.total)}</Text>
                <Text style={s.cnt}>{r.count} vta.</Text>
              </View>
            </View>
          );
        })
      )}
      <Text style={s.foot}>Total facturado (igual que el panel) · deslizá para refrescar</Text>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container: { padding: 16, paddingTop: 56, paddingBottom: 40 },
  backBtn: { marginBottom: 8 },
  back: { color: COLORS.red, fontWeight: '800', fontSize: 16 },
  title: { fontSize: 28, fontWeight: '900', color: COLORS.dark, marginBottom: 12 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 12 },
  chip: { paddingVertical: 7, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.card },
  chipOn: { backgroundColor: COLORS.red, borderColor: COLORS.red },
  chipTxt: { color: COLORS.dark, fontWeight: '700' },
  chipTxtOn: { color: '#fff' },
  tabs: { flexDirection: 'row', gap: 8, marginBottom: 14 },
  tab: { flex: 1, paddingVertical: 10, borderRadius: 12, borderWidth: 1, borderColor: COLORS.line, backgroundColor: COLORS.card, alignItems: 'center' },
  tabOn: { backgroundColor: COLORS.dark, borderColor: COLORS.dark },
  tabTxt: { color: COLORS.dark, fontWeight: '800' },
  tabTxtOn: { color: '#fff' },
  summary: { backgroundColor: COLORS.card, borderRadius: 16, padding: 16, borderWidth: 1, borderColor: COLORS.line, marginBottom: 14 },
  sumLbl: { color: COLORS.muted, fontWeight: '700', fontSize: 12 },
  sumVal: { color: COLORS.dark, fontWeight: '900', fontSize: 26, marginTop: 2 },
  sumSub: { color: COLORS.muted, marginTop: 2 },
  err: { color: COLORS.red, fontWeight: '700', marginVertical: 10 },
  row: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  rowLbl: { width: 52 },
  rowMain: { color: COLORS.dark, fontWeight: '800', fontSize: 13 },
  rowSub: { color: COLORS.muted, fontSize: 11 },
  barWrap: { flex: 1, height: 22, backgroundColor: COLORS.line, borderRadius: 6, marginHorizontal: 8, overflow: 'hidden', justifyContent: 'center' },
  bar: { height: 22, backgroundColor: COLORS.red, borderRadius: 6 },
  rowAmt: { width: 96, alignItems: 'flex-end' },
  amt: { color: COLORS.dark, fontWeight: '800', fontSize: 13 },
  cnt: { color: COLORS.muted, fontSize: 11 },
  foot: { textAlign: 'center', color: COLORS.muted, fontSize: 12, marginTop: 10 },
});
