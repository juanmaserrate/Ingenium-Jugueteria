import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, ActivityIndicator, StyleSheet } from 'react-native';
import { getBranches, getBranchUsers, loginPin } from '../api';
import { COLORS } from '../config';

export default function LoginScreen({ onLogin }) {
  const [branches, setBranches] = useState([]);
  const [branchId, setBranchId] = useState(null);
  const [users, setUsers] = useState([]);
  const [userId, setUserId] = useState(null);
  const [pin, setPin] = useState('');
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    getBranches().then(setBranches).catch(() => setErr('No se pudo conectar con el sistema'));
  }, []);

  useEffect(() => {
    if (!branchId) return;
    setUserId(null); setUsers([]);
    getBranchUsers(branchId).then(setUsers).catch(() => setUsers([]));
  }, [branchId]);

  const submit = async () => {
    if (!branchId || !userId || !pin) { setErr('Completá sucursal, usuario y PIN'); return; }
    setErr(''); setLoading(true);
    try {
      const res = await loginPin({ branchId, userId, pin });
      onLogin(res);
    } catch (e) {
      setErr(e.message || 'No se pudo iniciar sesión');
    } finally { setLoading(false); }
  };

  const fullName = (u) => `${u.name || ''} ${u.lastname || ''}`.trim() || u.id;

  return (
    <ScrollView contentContainerStyle={s.container} keyboardShouldPersistTaps="handled">
      <Text style={s.brand}>Ingenium</Text>
      <Text style={s.subtitle}>Panel de ventas</Text>

      <Text style={s.label}>Sucursal</Text>
      <View style={s.row}>
        {branches.map((b) => (
          <TouchableOpacity key={b.id} style={[s.chip, branchId === b.id && s.chipOn]} onPress={() => setBranchId(b.id)}>
            <Text style={[s.chipTxt, branchId === b.id && s.chipTxtOn]}>{b.name}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {branchId ? (
        <>
          <Text style={s.label}>Usuario</Text>
          <View style={s.row}>
            {users.map((u) => (
              <TouchableOpacity key={u.id} style={[s.chip, userId === u.id && s.chipOn]} onPress={() => setUserId(u.id)}>
                <Text style={[s.chipTxt, userId === u.id && s.chipTxtOn]}>{fullName(u)}</Text>
              </TouchableOpacity>
            ))}
            {!users.length && <Text style={s.muted}>Cargando usuarios…</Text>}
          </View>

          <Text style={s.label}>PIN</Text>
          <TextInput
            style={s.input}
            value={pin}
            onChangeText={setPin}
            placeholder="PIN"
            secureTextEntry
            autoCapitalize="none"
            keyboardType="visible-password"
          />
        </>
      ) : null}

      {err ? <Text style={s.err}>{err}</Text> : null}

      <TouchableOpacity style={[s.btn, loading && { opacity: 0.6 }]} onPress={submit} disabled={loading}>
        {loading ? <ActivityIndicator color="#fff" /> : <Text style={s.btnTxt}>Entrar</Text>}
      </TouchableOpacity>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container: { flexGrow: 1, backgroundColor: COLORS.bg, padding: 24, justifyContent: 'center' },
  brand: { fontSize: 36, fontWeight: '900', color: COLORS.red, textAlign: 'center' },
  subtitle: { fontSize: 16, color: COLORS.muted, textAlign: 'center', marginBottom: 24 },
  label: { fontSize: 12, fontWeight: '800', color: COLORS.muted, textTransform: 'uppercase', marginTop: 16, marginBottom: 6 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingVertical: 10, paddingHorizontal: 16, borderRadius: 999, backgroundColor: '#fff', borderWidth: 1, borderColor: COLORS.line },
  chipOn: { backgroundColor: COLORS.red, borderColor: COLORS.red },
  chipTxt: { color: COLORS.dark, fontWeight: '700' },
  chipTxtOn: { color: '#fff' },
  input: { backgroundColor: '#fff', borderWidth: 1, borderColor: COLORS.line, borderRadius: 12, padding: 14, fontSize: 18 },
  btn: { backgroundColor: COLORS.red, borderRadius: 14, padding: 16, alignItems: 'center', marginTop: 24 },
  btnTxt: { color: '#fff', fontWeight: '900', fontSize: 16 },
  err: { color: COLORS.red, marginTop: 14, fontWeight: '700' },
  muted: { color: COLORS.muted },
});
