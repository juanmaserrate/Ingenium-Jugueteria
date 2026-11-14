import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, RefreshControl, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { getBranches, getDashboard } from '../api';
import { COLORS } from '../config';

const money = (n) => '$' + Number(n || 0).toLocaleString('es-AR');

export default function DashboardScreen({ session, onLogout, onOpenSales }) {
  const [cards, setCards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [err, setErr] = useState('');
  const [updatedAt, setUpdatedAt] = useState(null);

  const isAdmin = session.user?.role === 'admin';

  const load = useCallback(async () => {
    try {
      setErr('');
      const brs = isAdmin ? await getBranches().catch(() => []) : [];
      // Admin: consolidado (las dos juntas) + cada sucursal. Encargado: sólo la suya.
      const targets = isAdmin
        ? [{ id: '', name: 'Las dos (juntas)', total: true }, ...brs.map((b) => ({ id: b.id, name: b.name }))]
        : [{ id: session.user.branchId, name: 'Mi sucursal' }];
      const out = await Promise.all(targets.map(async (t) => {
        const d = await getDashboard(session.token, t.id || undefined).catch(() => null);
        return { key: t.id || '__all__', name: t.name, total: !!t.total, d };
      }));
      setCards(out);
      setUpdatedAt(new Date());
    } catch {
      setErr('No se pudo cargar el panel');
    } finally {
      setLoading(false);
    }
  }, [session, isAdmin]);

  useEffect(() => {
    load();
    const iv = setInterval(load, 30000); // refresco cada 30 s
    return () => clearInterval(iv);
  }, [load]);

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  if (loading) {
    return <View style={s.center}><ActivityIndicator size="large" color={COLORS.red} /></View>;
  }

  return (
    <ScrollView
      style={{ backgroundColor: COLORS.bg }}
      contentContainerStyle={s.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.red} />}
    >
      <View style={s.header}>
        <View>
          <Text style={s.brand}>Ventas</Text>
          <Text style={s.muted}>{session.user?.name || 'Ingenium'}{updatedAt ? ` · ${updatedAt.toLocaleTimeString('es-AR')}` : ''}</Text>
        </View>
        <TouchableOpacity onPress={onLogout}><Text style={s.logout}>Salir</Text></TouchableOpacity>
      </View>

      {err ? <Text style={s.err}>{err}</Text> : null}

      {cards.map((c) => {
        const hoy = c.d?.today || { total: 0, count: 0 };
        const mes = c.d?.month || { total: 0, count: 0 };
        return (
          <TouchableOpacity
            key={c.key}
            activeOpacity={0.85}
            onPress={() => onOpenSales && onOpenSales(c.total ? '' : c.key, c.name)}
            style={[s.card, c.total && s.cardTotal]}
          >
            <Text style={[s.cardTitle, c.total && { color: '#fff' }]}>{c.name}</Text>
            <View style={s.line}>
              <Text style={[s.lblHoy, c.total && { color: '#ffd9d3' }]}>HOY</Text>
              <Text style={[s.big, c.total && { color: '#fff' }]}>{money(hoy.total)}</Text>
            </View>
            <Text style={[s.sub, c.total && { color: '#ffd9d3' }]}>{hoy.count} venta{hoy.count === 1 ? '' : 's'}</Text>
            <View style={[s.monthRow, c.total && { borderTopColor: 'rgba(255,255,255,0.25)' }]}>
              <Text style={[s.muted, c.total && { color: '#ffd9d3' }]}>Mes</Text>
              <Text style={[s.monthVal, c.total && { color: '#fff' }]}>{money(mes.total)} · {mes.count} vta.</Text>
            </View>
            <Text style={[s.tapHint, c.total && { color: '#ffd9d3' }]}>Ver ventas de hoy ›</Text>
          </TouchableOpacity>
        );
      })}

      <Text style={s.foot}>Tocá una tarjeta para ver los ítems vendidos · se refresca solo cada 30 s</Text>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  center: { flex: 1, backgroundColor: COLORS.bg, justifyContent: 'center', alignItems: 'center' },
  container: { padding: 16, paddingTop: 56, paddingBottom: 40 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 },
  brand: { fontSize: 30, fontWeight: '900', color: COLORS.dark },
  muted: { color: COLORS.muted, fontSize: 12 },
  logout: { color: COLORS.red, fontWeight: '800' },
  err: { color: COLORS.red, fontWeight: '700', marginBottom: 12 },
  card: { backgroundColor: COLORS.card, borderRadius: 18, padding: 18, marginBottom: 14, borderWidth: 1, borderColor: COLORS.line },
  cardTotal: { backgroundColor: COLORS.red, borderColor: COLORS.red },
  cardTitle: { fontSize: 18, fontWeight: '900', color: COLORS.dark, marginBottom: 8 },
  line: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  lblHoy: { fontSize: 12, fontWeight: '800', color: COLORS.muted },
  big: { fontSize: 30, fontWeight: '900', color: COLORS.dark },
  sub: { color: COLORS.muted, marginTop: 2 },
  monthRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: COLORS.line },
  monthVal: { fontWeight: '800', color: COLORS.dark },
  tapHint: { marginTop: 10, color: COLORS.red, fontWeight: '800', fontSize: 12, textAlign: 'right' },
  foot: { textAlign: 'center', color: COLORS.muted, fontSize: 12, marginTop: 8 },
});
