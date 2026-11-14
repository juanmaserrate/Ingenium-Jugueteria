import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, RefreshControl, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { getSalesToday } from '../api';
import { COLORS } from '../config';

const money = (n) => '$' + Number(n || 0).toLocaleString('es-AR');
const timeOf = (dt) => { try { return new Date(dt).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
const canal = (src) => (src === 'tn' ? 'Tienda Nube' : src === 'ml' ? 'Mercado Libre' : 'Local');

export default function SalesScreen({ session, branchId, name, onBack }) {
  const [sales, setSales] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      setErr('');
      const data = await getSalesToday(session.token, branchId || undefined);
      setSales(Array.isArray(data) ? data : []);
    } catch {
      setErr('No se pudieron cargar las ventas');
    } finally {
      setLoading(false);
    }
  }, [session, branchId]);

  useEffect(() => {
    load();
    const iv = setInterval(load, 30000);
    return () => clearInterval(iv);
  }, [load]);

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const totalDia = sales.reduce((n, s) => n + (s.total || 0), 0);

  if (loading) return <View style={s.center}><ActivityIndicator size="large" color={COLORS.red} /></View>;

  return (
    <ScrollView
      style={{ backgroundColor: COLORS.bg }}
      contentContainerStyle={s.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.red} />}
    >
      <TouchableOpacity onPress={onBack} style={s.backBtn}><Text style={s.back}>‹ Volver al panel</Text></TouchableOpacity>
      <Text style={s.title}>Ventas de hoy</Text>
      <Text style={s.muted}>{name} · {sales.length} venta{sales.length === 1 ? '' : 's'} · {money(totalDia)}</Text>

      {err ? <Text style={s.err}>{err}</Text> : null}
      {!sales.length && !err ? <Text style={[s.muted, { marginTop: 24 }]}>Todavía no hay ventas hoy.</Text> : null}

      {sales.map((sale) => (
        <View key={sale.id} style={s.card}>
          <View style={s.cardTop}>
            <Text style={s.num}>#{sale.number}</Text>
            <Text style={s.total}>{money(sale.total)}</Text>
          </View>
          <Text style={s.meta}>
            {timeOf(sale.datetime)} · {canal(sale.source)}{sale.customer?.name ? ` · ${sale.customer.name}` : ''}
          </Text>
          <View style={s.items}>
            {(sale.items || []).map((it, idx) => {
              const v = it.variantNameSnap && it.variantNameSnap !== 'default' ? ` (${it.variantNameSnap})` : '';
              return (
                <View key={idx} style={s.itemRow}>
                  <Text style={s.itemName}>{it.qty}× {it.productNameSnap}{v}</Text>
                  <Text style={s.itemAmt}>{money(it.subtotal)}</Text>
                </View>
              );
            })}
          </View>
        </View>
      ))}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  center: { flex: 1, backgroundColor: COLORS.bg, justifyContent: 'center', alignItems: 'center' },
  container: { padding: 16, paddingTop: 56, paddingBottom: 40 },
  backBtn: { marginBottom: 8 },
  back: { color: COLORS.red, fontWeight: '800', fontSize: 16 },
  title: { fontSize: 28, fontWeight: '900', color: COLORS.dark },
  muted: { color: COLORS.muted, marginTop: 2 },
  err: { color: COLORS.red, fontWeight: '700', marginTop: 12 },
  card: { backgroundColor: COLORS.card, borderRadius: 16, padding: 16, marginTop: 14, borderWidth: 1, borderColor: COLORS.line },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  num: { fontSize: 16, fontWeight: '900', color: COLORS.dark },
  total: { fontSize: 18, fontWeight: '900', color: COLORS.red },
  meta: { color: COLORS.muted, fontSize: 12, marginTop: 2 },
  items: { marginTop: 10, borderTopWidth: 1, borderTopColor: COLORS.line, paddingTop: 8, gap: 4 },
  itemRow: { flexDirection: 'row', justifyContent: 'space-between' },
  itemName: { color: COLORS.dark, flex: 1, paddingRight: 8 },
  itemAmt: { color: COLORS.muted, fontWeight: '700' },
});
